/**
 * AGENT_SKILL_SOURCES — shared skill-source layer builder.
 *
 * Extracted from compose.service so BOTH the full composer (compose.service) and
 * the governed stage-prompt resolver (stage-prompts.service) render the *same*
 * skill-source + permission context. Previously only the full composer emitted
 * this layer, so governed SDLC stages didn't tell the model which sources are
 * read-only knowledge vs invokable tools.
 */
import { runtimeReader } from "../../config/prisma";

const CAPABILITY_PERMISSION_ORDER = ["read", "invoke", "configure", "edit"] as const;

/**
 * Normalize a skill/capability's permission set: dedupe, clamp to read when
 * read-only/provider-locked, guarantee "read", and order read < invoke <
 * configure < edit.
 */
export function effectiveCapabilityPermissions(
  permissions: unknown,
  opts: { readOnly?: boolean | null; providerLocked?: boolean | null; fallback?: string[] } = {},
): string[] {
  const normalized = Array.isArray(permissions)
    ? permissions.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  let unique = Array.from(new Set(normalized));
  if (unique.length === 0) unique = opts.fallback?.length ? opts.fallback : ["read"];
  if (opts.readOnly || opts.providerLocked) unique = unique.filter((permission) => permission === "read");
  if (!unique.includes("read")) unique.unshift("read");
  return unique.sort((a, b) => {
    const ai = CAPABILITY_PERMISSION_ORDER.indexOf(a as typeof CAPABILITY_PERMISSION_ORDER[number]);
    const bi = CAPABILITY_PERMISSION_ORDER.indexOf(b as typeof CAPABILITY_PERMISSION_ORDER[number]);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

/**
 * Build the AGENT_SKILL_SOURCES layer for an agent template: its bound skill
 * sources, each with source type, effective permissions, and read-only /
 * provider-locked markers. Returns null when the template has no bound skills.
 */
export async function buildAgentSkillSourceLayer(agentTemplateId: string): Promise<string | null> {
  const rows = await runtimeReader.agentTemplateSkill.findMany({
    where: { agentTemplateId },
    orderBy: { createdAt: "asc" },
    include: { skill: true },
  });
  if (rows.length === 0) return null;
  const lines = ["Agent profile skill sources:"];
  for (const row of rows) {
    const permissions = effectiveCapabilityPermissions(row.permissions, {
      readOnly: row.readOnly,
      providerLocked: row.providerLocked,
      fallback: ["read"],
    });
    const access = [
      permissions.join(","),
      row.readOnly ? "read-only" : null,
      row.providerLocked ? "provider-locked" : null,
    ].filter(Boolean).join("; ");
    lines.push(`- ${row.skill.name} [${row.sourceType}] permissions=${access}`);
    if (row.sourceRef) lines.push(`  Source: ${row.sourceRef}`);
    if (row.skill.description) lines.push(`  Purpose: ${row.skill.description}`);
  }
  lines.push("Use read-only sources only as reference context. Invoke or edit only when the capability permissions explicitly allow it.");
  return lines.join("\n");
}
