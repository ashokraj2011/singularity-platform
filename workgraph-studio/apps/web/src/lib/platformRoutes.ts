// Maps workgraph-web's historical internal route paths (from the old standalone
// SPA and the MemoryRouter embed) to the canonical platform-web Next routes.
//
// These feature pages now run in-process inside platform-web (Next.js), so every
// navigation must target a REAL Next route — e.g. the old internal "/runtime"
// inbox is "/workflows/inbox" in platform-web, and "/mission-control/:id" is
// "/runs/:id/insights". Centralizing the mapping here keeps every navigate()/
// <Link> call correct from one source of truth, mirroring the redirect table in
// agent-and-tools/web/next.config.mjs.
//
// Anything already canonical (/runs, /runs/:id[/artifacts|/insights],
// /work-items, /workflows[?...]) passes through unchanged.

const RULES: Array<[RegExp, string]> = [
  [/^\/mission-control\/([^/?]+)(.*)$/, "/runs/$1/insights$2"],
  [/^\/play\/new(\?.*)?$/, "/workflows/run$1"],
  [/^\/play\/([^/?]+)(.*)$/, "/runs/$1$2"],
  [/^\/runtime\/history(\?.*)?$/, "/workflows/history$1"],
  [/^\/runtime\/work\/(.*)$/, "/workflows/work/$1"],
  [/^\/runtime(\?.*)?$/, "/workflows/inbox$1"],
  [/^\/design\/(.*)$/, "/workflows/design/$1"],
  [/^\/artifacts-explorer(\?.*)?$/, "/workflows/artifacts/explorer$1"],
  [/^\/artifacts\/(.*)$/, "/workflows/artifacts/$1"],
  [/^\/artifacts(\?.*)?$/, "/workflows/artifacts$1"],
  [/^\/connectors(\?.*)?$/, "/workflows/connectors$1"],
  [/^\/metadata(\?.*)?$/, "/workflows/metadata$1"],
  [/^\/node-types(\?.*)?$/, "/workflows/node-types$1"],
  [/^\/curation(\?.*)?$/, "/audit/curation$1"],
  [/^\/team-variables(\?.*)?$/, "/identity/variables$1"],
  [/^\/run(\?.*)?$/, "/workflows/run$1"],
  [/^\/templates(\?.*)?$/, "/workflows/templates$1"],
  [/^\/dashboard(\?.*)?$/, "/$1"],
  [/^\/login(\?.*)?$/, "/identity/login$1"],
  [/^\/$/, "/workflows"],
];

/**
 * Translate a workgraph-web internal path to its platform-web Next route.
 * Non-absolute inputs (already-resolved hrefs, external URLs) are returned as-is.
 */
export function toPlatformPath(internal: string): string {
  if (!internal || !internal.startsWith("/")) return internal;
  for (const [re, repl] of RULES) {
    if (re.test(internal)) return internal.replace(re, repl);
  }
  return internal;
}
