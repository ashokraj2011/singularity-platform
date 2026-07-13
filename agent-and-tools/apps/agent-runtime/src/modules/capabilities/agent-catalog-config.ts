import fs from "fs";
import path from "path";
import { z } from "zod";

/**
 * Externalized bootstrap agent catalog — the role-agents a capability's team is
 * built from at onboarding, plus the named team presets.
 *
 * Historically this was a hard-coded `BOOTSTRAP_AGENT_CATALOG` const + three
 * hard-coded preset key-sets in capability.service.ts. It is now loadable from
 * config so role names, locked/activation gates, and team composition change
 * WITHOUT a code edit, following the same env-pointed-JSON pattern as
 * mcp-server's `llm/provider-config.ts`:
 *
 *   AGENT_CATALOG_JSON  — inline JSON (takes precedence), or
 *   AGENT_CATALOG_PATH  — path to a JSON file (hot-reloaded by mtime).
 *
 * When neither is set, or the supplied config is invalid, the compiled-in
 * default below is used (a missing/broken file can never brick onboarding —
 * it degrades to today's exact 9-agent catalog and surfaces a warning).
 *
 * `roleType`/`baseRoleType` are validated against the platform's AgentRoleType
 * enum (a capability AgentTemplate is stored with this enum). `bindingRole` is a
 * free string (e.g. "VERIFIER" is a binding role, not an AgentRoleType) written
 * to AgentCapabilityBinding.roleInCapability.
 */

// Mirror of the prisma AgentRoleType enum (prisma/schema.prisma). A new role still
// requires a prisma migration to add the enum value, so config can only reference
// roles the DB can actually store.
export const AGENT_ROLE_TYPES = [
  "ARCHITECT",
  "DEVELOPER",
  "QA",
  "GOVERNANCE",
  "BUSINESS_ANALYST",
  "PRODUCT_OWNER",
  "DEVOPS",
  "SECURITY",
] as const;

const AgentCatalogItemSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  roleType: z.enum(AGENT_ROLE_TYPES),
  bindingRole: z.string().min(1),
  baseRoleType: z.enum(AGENT_ROLE_TYPES),
  locked: z.boolean(),
  activationRequired: z.boolean(),
  learnsFromGit: z.boolean(),
  grounding: z.string(),
  description: z.string(),
});

const AgentCatalogPresetSchema = z.object({
  label: z.string().min(1),
  agents: z.array(z.string().min(1)),
});

const AgentCatalogSchema = z
  .object({
    agents: z.array(AgentCatalogItemSchema).min(1),
    presets: z.record(AgentCatalogPresetSchema),
    defaultPreset: z.string().min(1),
  })
  .superRefine((cfg, ctx) => {
    const keys = new Set(cfg.agents.map((a) => a.key));
    if (keys.size !== cfg.agents.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "agent keys must be unique" });
    }
    if (!cfg.presets[cfg.defaultPreset]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `defaultPreset "${cfg.defaultPreset}" is not defined in presets` });
    }
    for (const [name, preset] of Object.entries(cfg.presets)) {
      for (const key of preset.agents) {
        if (!keys.has(key)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `preset "${name}" references unknown agent key "${key}"` });
        }
      }
    }
  });

export type AgentCatalogItem = z.infer<typeof AgentCatalogItemSchema>;
export type AgentCatalogPreset = z.infer<typeof AgentCatalogPresetSchema>;
export type AgentCatalog = z.infer<typeof AgentCatalogSchema>;

// The compiled-in default — the historical BOOTSTRAP_AGENT_CATALOG (9 role-agents)
// + the 3 presets. Parsed through the schema at load so it can never drift out of
// shape, and used verbatim when no external config is supplied.
const DEFAULT_CATALOG_INPUT = {
  agents: [
    {
      key: "product_owner",
      label: "Product Owner",
      roleType: "PRODUCT_OWNER",
      bindingRole: "PRODUCT_OWNER",
      baseRoleType: "PRODUCT_OWNER",
      locked: false,
      activationRequired: false,
      learnsFromGit: true,
      grounding: "Learns story shape, domain terms, acceptance contracts, and release scope from approved repo/docs.",
      description: "Clarifies outcomes, acceptance criteria, user impact, and scope before engineering starts.",
    },
    {
      key: "business_analyst",
      label: "Business Analyst",
      roleType: "BUSINESS_ANALYST",
      bindingRole: "BUSINESS_ANALYST",
      baseRoleType: "PRODUCT_OWNER",
      locked: false,
      activationRequired: false,
      learnsFromGit: true,
      grounding: "Learns domain vocabulary, process rules, validation paths, and edge cases from approved sources.",
      description: "Extracts business rules, constraints, process impact, and open questions.",
    },
    {
      key: "architect",
      label: "Architect",
      roleType: "ARCHITECT",
      bindingRole: "ARCHITECT",
      baseRoleType: "ARCHITECT",
      locked: false,
      activationRequired: false,
      learnsFromGit: true,
      grounding: "Learns architecture, dependency boundaries, modules, and code ownership from approved Git/doc signals.",
      description: "Owns design shape, dependencies, tradeoffs, and implementation plan quality.",
    },
    {
      key: "developer",
      label: "Developer",
      roleType: "DEVELOPER",
      bindingRole: "DEVELOPER",
      baseRoleType: "DEVELOPER",
      locked: false,
      activationRequired: false,
      learnsFromGit: true,
      grounding: "Learns build/run conventions, source layout, component patterns, and local MCP AST/code symbols.",
      description: "Produces implementation tasks, code-change evidence, and handoff notes grounded in the capability codebase.",
    },
    {
      key: "verifier",
      label: "Verifier",
      roleType: "QA",
      bindingRole: "VERIFIER",
      baseRoleType: "QA",
      locked: true,
      activationRequired: true,
      learnsFromGit: true,
      grounding: "Learns test strategy, expected behavior, regression risks, and proof requirements from approved sources.",
      description: "Locked verification gate. Reviews evidence, tests, acceptance criteria, and traceability before completion.",
    },
    {
      key: "qa",
      label: "QA",
      roleType: "QA",
      bindingRole: "QA",
      baseRoleType: "QA",
      locked: false,
      activationRequired: false,
      learnsFromGit: true,
      grounding: "Learns existing test layout, quality signals, and regression coverage from approved source context.",
      description: "Creates QA task packs, regression checks, and release confidence evidence.",
    },
    {
      key: "security",
      label: "Security",
      roleType: "SECURITY",
      bindingRole: "SECURITY",
      baseRoleType: "SECURITY",
      locked: true,
      activationRequired: true,
      learnsFromGit: true,
      grounding: "Learns authentication, data handling, secrets, dependency risk, and threat boundaries from approved sources.",
      description: "Locked security gate. Reviews unsafe tool use, data exposure, authz, dependency risk, and evidence.",
    },
    {
      key: "devops",
      label: "DevOps",
      roleType: "DEVOPS",
      bindingRole: "DEVOPS",
      baseRoleType: "DEVOPS",
      locked: false,
      activationRequired: false,
      learnsFromGit: true,
      grounding: "Learns build, deployment, observability, rollback, and environment readiness from approved runbooks.",
      description: "Owns release readiness, deployability, rollback, and operational evidence.",
    },
    {
      key: "governance",
      label: "Governance",
      roleType: "GOVERNANCE",
      bindingRole: "GOVERNANCE",
      baseRoleType: "GOVERNANCE",
      locked: true,
      activationRequired: true,
      learnsFromGit: false,
      grounding: "Grounded to capability identity, owner team, approvals, budget policy, audit receipts, and required evidence.",
      description: "Locked governance gate. Verifies approvals, budgets, receipts, policy, and promotion readiness.",
    },
  ],
  presets: {
    minimal: {
      label: "Minimal governed crew",
      agents: ["product_owner", "architect", "developer", "verifier", "governance"],
    },
    engineering_core: {
      label: "Engineering core crew",
      agents: ["product_owner", "business_analyst", "architect", "developer", "verifier", "qa", "security", "devops", "governance"],
    },
    governed_delivery: {
      label: "Full governed delivery crew",
      agents: ["product_owner", "business_analyst", "architect", "developer", "verifier", "qa", "security", "devops", "governance"],
    },
  },
  defaultPreset: "governed_delivery",
};

// Parsed once — also acts as a build-time guard that the default is always valid.
export const DEFAULT_AGENT_CATALOG: AgentCatalog = AgentCatalogSchema.parse(DEFAULT_CATALOG_INPUT);

export type LoadedAgentCatalog = { catalog: AgentCatalog; source: string; warnings: string[] };

/**
 * Pure: turn a raw parsed value into a validated catalog, degrading to the
 * built-in default (with a warning) on null/invalid input. No env, no I/O — the
 * unit-testable core.
 */
export function parseAgentCatalog(raw: unknown, sourceLabel: string): LoadedAgentCatalog {
  if (raw === null || raw === undefined) {
    return { catalog: DEFAULT_AGENT_CATALOG, source: "default", warnings: [] };
  }
  const parsed = AgentCatalogSchema.safeParse(raw);
  if (parsed.success) {
    return { catalog: parsed.data, source: sourceLabel, warnings: [] };
  }
  const warning = `ConfigurationError: invalid agent catalog from ${sourceLabel}; using the built-in default. ${JSON.stringify(parsed.error.flatten())}`;
  return { catalog: DEFAULT_AGENT_CATALOG, source: "degraded-default", warnings: [warning] };
}

let cached: LoadedAgentCatalog | null = null;
let cachedKey = "";

// Cache key = "env-json" / "default" / "<resolved path>:<mtimeMs>", so an edited
// catalog file is picked up without a restart (mirrors provider-config.ts).
function currentCacheKey(): string {
  if (process.env.AGENT_CATALOG_JSON?.trim()) return "env-json";
  const raw = process.env.AGENT_CATALOG_PATH?.trim();
  if (!raw) return "default";
  const p = path.resolve(raw);
  try {
    return `${p}:${fs.statSync(p).mtimeMs}`;
  } catch {
    return `${p}:missing`;
  }
}

function readCatalogSource(): { raw: unknown; label: string } {
  const inline = process.env.AGENT_CATALOG_JSON?.trim();
  if (inline) return { raw: JSON.parse(inline), label: "AGENT_CATALOG_JSON" };
  const filePath = process.env.AGENT_CATALOG_PATH?.trim();
  if (filePath) {
    const resolved = path.resolve(filePath);
    return { raw: JSON.parse(fs.readFileSync(resolved, "utf8")), label: `AGENT_CATALOG_PATH (${resolved})` };
  }
  return { raw: null, label: "default" };
}

/** Load (and cache) the effective agent catalog from config, degrading to the
 * built-in default on any read/parse error. */
export function loadAgentCatalogWithMeta(): LoadedAgentCatalog {
  const key = currentCacheKey();
  if (cached && key === cachedKey) return cached;
  cachedKey = key;
  try {
    const { raw, label } = readCatalogSource();
    cached = parseAgentCatalog(raw, label);
  } catch (err) {
    const warning = `ConfigurationError: failed to read agent catalog config; using the built-in default. ${err instanceof Error ? err.message : String(err)}`;
    cached = { catalog: DEFAULT_AGENT_CATALOG, source: "degraded-default", warnings: [warning] };
  }
  for (const warning of cached.warnings) console.warn(`[agent-catalog] ${warning}`);
  return cached;
}

export function loadAgentCatalog(): AgentCatalog {
  return loadAgentCatalogWithMeta().catalog;
}

/** Test-only: drop the memoized catalog so the next load re-reads config. */
export function resetAgentCatalogCache(): void {
  cached = null;
  cachedKey = "";
}
