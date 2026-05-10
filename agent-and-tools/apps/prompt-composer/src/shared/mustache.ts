/**
 * Mustache-style variable substitution for prompt content.
 *
 * Resolves `{{path.to.value}}` against a context object. Examples:
 *   {{instance.vars.tenant_id}}
 *   {{instance.globals.environment}}
 *   {{node.priorOutputs.research_summary}}
 *   {{capability.metadata.industry}}
 *   {{artifacts.contract.excerpt}}
 *   {{task}}
 *
 * Unresolved paths render as empty strings and are reported via `warnings`.
 */
export interface RenderResult {
  rendered: string;
  warnings: string[];
}

const TOKEN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;

export function render(template: string, ctx: Record<string, unknown>): RenderResult {
  const warnings: string[] = [];
  const rendered = template.replace(TOKEN, (_match, path: string) => {
    const value = lookup(ctx, path);
    if (value === undefined) {
      warnings.push(`unresolved: {{${path}}}`);
      return "";
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  });
  return { rendered, warnings };
}

function lookup(ctx: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
