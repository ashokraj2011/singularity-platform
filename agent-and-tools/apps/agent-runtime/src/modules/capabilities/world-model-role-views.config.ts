/**
 * Which views an agent role actually loads — PURE, no I/O beyond reading config.
 *
 * This is the "loaded narrowly" half of the design. Views are built broadly (a
 * capability may carry all ten), but a developer agent should never be handed
 * the release runbook and a tester should never be handed the business case.
 * The routing table is the single place that decision is encoded.
 *
 * It is config, not code, because role vocabularies drift per deployment: one
 * org's "sre" is another's "operations". The compiled default covers the roles
 * the platform ships; WORLD_MODEL_ROLE_VIEWS_JSON (or _PATH) replaces it whole.
 *
 * Two invariants survive any override:
 *  - core_summary is always first. It is the shared ground every role needs, and
 *    a slice without it describes a capability nobody can place.
 *  - the budget is real. Views are 6-18K chars each and the workflow path caps
 *    the whole prompt at 24K, so an unbudgeted slice would silently evict the
 *    task itself.
 */

import fs from "node:fs";
import path from "node:path";
import { isWorldModelViewKind, type WorldModelViewKind } from "./world-model-views.types";

export type SliceBudget = { maxViews: number; maxTotalChars: number };

export type RoleViewsConfig = {
  /** role (lowercased) → the role views it loads, in priority order. */
  roles: Record<string, WorldModelViewKind[]>;
  /** Used when a role is absent from the table. */
  fallbackRole: string;
  budget: SliceBudget;
};

/**
 * The shipped table. Aliases are listed explicitly rather than normalised by
 * prefix — "qa" and "quality_engineer" have nothing textual in common, and
 * guessing is how a role silently lands on the wrong view.
 */
export const DEFAULT_ROLE_VIEWS: RoleViewsConfig = {
  roles: {
    developer: ["development"],
    engineer: ["development"],
    coder: ["development"],
    implementer: ["development"],

    tester: ["testing"],
    qa: ["testing"],
    quality_engineer: ["testing"],

    // An architect reviews for structure and exposure together; security is the
    // one view that routinely changes an architectural verdict.
    architect: ["architecture", "security"],
    principal_engineer: ["architecture", "development"],

    // A release owner needs to know what ships, whether it is proven, and what
    // happens when it misbehaves.
    release: ["release", "testing", "operations"],
    release_manager: ["release", "testing", "operations"],

    operations: ["operations"],
    sre: ["operations", "security"],
    support: ["operations"],

    security: ["security"],
    security_engineer: ["security"],

    business: ["business"],
    product_owner: ["business"],
    product_manager: ["business"],
    analyst: ["business"],
  },
  fallbackRole: "developer",
  budget: { maxViews: 3, maxTotalChars: 9000 },
};

const ENV_INLINE = "WORLD_MODEL_ROLE_VIEWS_JSON";
const ENV_PATH = "WORLD_MODEL_ROLE_VIEWS_PATH";

export type LoadedRoleViews = {
  config: RoleViewsConfig;
  source: string;
  warnings: string[];
};

let cached: LoadedRoleViews | null = null;
let cachedKey = "";

function currentCacheKey(): string {
  const inline = process.env[ENV_INLINE]?.trim() ?? "";
  const filePath = process.env[ENV_PATH]?.trim() ?? "";
  if (inline) return `inline:${inline.length}:${inline.slice(0, 64)}`;
  if (!filePath) return "default";
  const resolved = path.resolve(filePath);
  try {
    return `${resolved}:${fs.statSync(resolved).mtimeMs}`;
  } catch {
    return `${resolved}:missing`;
  }
}

function readSource(): { raw: unknown; label: string } {
  const inline = process.env[ENV_INLINE]?.trim();
  if (inline) return { raw: JSON.parse(inline), label: ENV_INLINE };
  const filePath = process.env[ENV_PATH]?.trim();
  if (filePath) {
    const resolved = path.resolve(filePath);
    return { raw: JSON.parse(fs.readFileSync(resolved, "utf8")), label: `${ENV_PATH} (${resolved})` };
  }
  return { raw: null, label: "default" };
}

/**
 * Parse an override. Unknown view kinds are dropped with a warning rather than
 * failing the load: a typo in one role's list should cost that role its extra
 * view, not take grounding away from every other role on the platform.
 */
export function parseRoleViews(raw: unknown, label: string): LoadedRoleViews {
  if (raw === null || raw === undefined) {
    return { config: DEFAULT_ROLE_VIEWS, source: "default", warnings: [] };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      config: DEFAULT_ROLE_VIEWS,
      source: "degraded-default",
      warnings: [`${label} must be a JSON object; using the built-in default`],
    };
  }

  const warnings: string[] = [];
  const input = raw as Partial<RoleViewsConfig>;
  const roles: Record<string, WorldModelViewKind[]> = {};

  const rawRoles = input.roles;
  if (rawRoles && typeof rawRoles === "object" && !Array.isArray(rawRoles)) {
    for (const [role, kinds] of Object.entries(rawRoles)) {
      const key = role.trim().toLowerCase();
      if (!key) continue;
      if (!Array.isArray(kinds)) {
        warnings.push(`role "${key}" must map to an array of view kinds; ignored`);
        continue;
      }
      const valid = kinds.filter((k): k is WorldModelViewKind => {
        if (isWorldModelViewKind(k)) return true;
        warnings.push(`role "${key}" lists unknown view kind ${JSON.stringify(k)}; dropped`);
        return false;
      });
      // core_summary is prepended at slice time; listing it here would double it.
      roles[key] = valid.filter((k) => k !== "core_summary");
    }
  } else if (rawRoles !== undefined) {
    warnings.push("roles must be an object; using the built-in role table");
  }

  const fallbackRaw = typeof input.fallbackRole === "string" ? input.fallbackRole.trim().toLowerCase() : "";
  const effectiveRoles = Object.keys(roles).length > 0 ? roles : DEFAULT_ROLE_VIEWS.roles;
  let fallbackRole = fallbackRaw || DEFAULT_ROLE_VIEWS.fallbackRole;
  if (!effectiveRoles[fallbackRole]) {
    // A fallback that resolves to nothing would leave unknown roles with core
    // only — legal, but almost never what an operator meant to configure.
    warnings.push(`fallbackRole "${fallbackRole}" is not in the role table; unknown roles will load the core view only`);
  }

  const budget = { ...DEFAULT_ROLE_VIEWS.budget };
  const rawBudget = input.budget;
  if (rawBudget && typeof rawBudget === "object") {
    const b = rawBudget as Partial<SliceBudget>;
    if (typeof b.maxViews === "number" && Number.isFinite(b.maxViews) && b.maxViews >= 1) budget.maxViews = Math.floor(b.maxViews);
    else if (b.maxViews !== undefined) warnings.push("budget.maxViews must be a number >= 1; kept the default");
    if (typeof b.maxTotalChars === "number" && Number.isFinite(b.maxTotalChars) && b.maxTotalChars >= 1000) budget.maxTotalChars = Math.floor(b.maxTotalChars);
    else if (b.maxTotalChars !== undefined) warnings.push("budget.maxTotalChars must be a number >= 1000; kept the default");
  }

  return { config: { roles: effectiveRoles, fallbackRole, budget }, source: label, warnings };
}

export function loadRoleViewsWithMeta(): LoadedRoleViews {
  const key = currentCacheKey();
  if (cached && key === cachedKey) return cached;
  cachedKey = key;
  try {
    const { raw, label } = readSource();
    cached = parseRoleViews(raw, label);
  } catch (err) {
    cached = {
      config: DEFAULT_ROLE_VIEWS,
      source: "degraded-default",
      warnings: [`ConfigurationError: failed to read role-view config; using the built-in default. ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  for (const warning of cached.warnings) console.warn(`[world-model-role-views] ${warning}`);
  return cached;
}

export function loadRoleViews(): RoleViewsConfig {
  return loadRoleViewsWithMeta().config;
}

/** Test-only: drop the memoized config so the next load re-reads the environment. */
export function resetRoleViewsCache(): void {
  cached = null;
  cachedKey = "";
}

export type RoleRouting = {
  role: string;
  matched: boolean;
  kinds: WorldModelViewKind[];
  reason: string;
};

/**
 * Resolve a role to the view kinds it should load, core first.
 *
 * An unrecognised role is not an error — roles arrive from workflow configs this
 * service does not own. It falls back rather than returning nothing, because a
 * developer-shaped default is far more useful to an unknown agent than silence.
 */
export function resolveRoleViews(role: string | null | undefined, config = loadRoleViews()): RoleRouting {
  const normalized = (role ?? "").trim().toLowerCase();
  const direct = normalized ? config.roles[normalized] : undefined;
  if (direct) {
    return { role: normalized, matched: true, kinds: ["core_summary", ...direct], reason: `role "${normalized}"` };
  }
  const fallback = config.roles[config.fallbackRole] ?? [];
  return {
    role: normalized,
    matched: false,
    kinds: ["core_summary", ...fallback],
    reason: normalized
      ? `unknown role "${normalized}"; fell back to "${config.fallbackRole}"`
      : `no role supplied; fell back to "${config.fallbackRole}"`,
  };
}
