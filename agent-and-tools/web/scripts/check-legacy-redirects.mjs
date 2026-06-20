import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import nextConfig from "../next.config.mjs";

const redirects = await nextConfig.redirects();
const redirectMap = new Map(redirects.map((redirect) => [redirect.source, redirect.destination]));

const expected = {
  "/design/:workflowId": "/workflows/design/:workflowId",
  "/workflow": "/workflows",
  "/workflow/dashboard": "/",
  "/workflow/login": "/identity/login",
  "/workflow/context-picker": "/identity/dashboard",
  "/workflow/planner": "/workflows/planner",
  "/workflow/runtime": "/workflows/inbox",
  "/workflow/runtime/history": "/workflows/history",
  "/workflow/runtime/work/:kind/:id": "/workflows/work/:kind/:id",
  "/workflow/run": "/workflows/run",
  "/workflow/workflows": "/workflows/templates",
  "/workflow/templates": "/workflows/templates",
  "/workflow/node-types": "/workflows/node-types",
  "/workflow/design/:workflowId": "/workflows/design/:workflowId",
  "/workflow/runs": "/runs",
  "/workflow/runs/:id": "/runs/:id",
  "/workflow/runs/:id/artifacts": "/runs/:id/artifacts",
  "/workflow/runs/:id/insights": "/runs/:id/insights",
  "/workflow/artifacts-explorer": "/workflows/artifacts/explorer",
  "/workflow/artifacts": "/workflows/artifacts",
  "/workflow/artifacts/:id": "/workflows/artifacts/:id",
  "/workflow/mission-control/:id": "/runs/:id/insights",
  "/workflow/play/new": "/workflows/run",
  "/workflow/play/:runId": "/runs/:runId",
  "/workflow/connectors": "/workflows/connectors",
  "/workflow/llm-routing": "/llm-settings",
  "/workflow/audit": "/audit",
  "/workflow/curation": "/audit/curation",
  "/workflow/metadata": "/workflows/metadata",
  "/workflow/history": "/workflows/history",
  "/workflow/team-variables": "/identity/variables",
  "/workflow/global-variables": "/identity/variables",
  "/workflow/:instanceId": "/runs/:instanceId",
  "/workflows/workflows": "/workflows/templates",
  "/workflows/runs": "/runs",
  "/workflows/runs/:id": "/runs/:id",
};

for (const [source, destination] of Object.entries(expected)) {
  assert.equal(redirectMap.get(source), destination, `${source} should redirect to ${destination}`);
}

const sources = redirects.map((redirect) => redirect.source);
for (const specific of [
  "/workflow/design/:workflowId",
  "/workflow/runs/:id",
  "/workflow/play/new",
  "/workflow/workflows",
]) {
  assert.ok(
    sources.indexOf(specific) < sources.indexOf("/workflow/:instanceId"),
    `${specific} must be checked before /workflow/:instanceId`,
  );
}

for (const routeModule of [
  "src/app/workflow/api/[...path]/route.ts",
  "src/app/workflows/api/[...path]/route.ts",
  "src/app/workbench/api/[...path]/route.ts",
  "src/app/workbench/audit-gov/[...path]/route.ts",
  "src/app/foundry/api/[...path]/route.ts",
  "src/app/audit-gov/[...path]/route.ts",
]) {
  assert.ok(existsSync(new URL(`../${routeModule}`, import.meta.url)), `${routeModule} must preserve legacy JSON API compatibility`);
}

function appPageFor(href) {
  if (href === "/") return "src/app/page.tsx";
  return `src/app${href}/page.tsx`;
}

function quotedPathSet(source) {
  return new Set(
    [...source.matchAll(/(?:href|nativeHref):\s*"([^"]+)"/g), ...source.matchAll(/href="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((href) => href.startsWith("/") && !href.includes("$") && !href.includes(":")),
  );
}

const sidebarSource = readFileSync(new URL("../src/components/ui/Sidebar.tsx", import.meta.url), "utf8");
const appSwitcherSource = readFileSync(new URL("../src/components/AppSwitcher.tsx", import.meta.url), "utf8");
const controlPlaneSource = readFileSync(new URL("../src/lib/controlPlaneApps.ts", import.meta.url), "utf8");
assert.ok(controlPlaneSource.includes('id: "foundry"'), "App switcher must expose Foundry as a first-class unified app");
assert.ok(appSwitcherSource.includes('pathname.startsWith("/foundry")'), "App switcher must detect Foundry routes as the current app");

for (const href of new Set([...quotedPathSet(sidebarSource), ...quotedPathSet(controlPlaneSource)])) {
  assert.ok(
    existsSync(new URL(`../${appPageFor(href)}`, import.meta.url)),
    `Shell link ${href} must resolve to an app page`,
  );
}

const workflowDesignPage = readFileSync(new URL("../src/app/workflows/design/[id]/page.tsx", import.meta.url), "utf8");
assert.ok(
  workflowDesignPage.includes("LegacyWorkflowDesignRoute"),
  "Workflow design route must use the full legacy Workgraph router so in-designer navigation keeps working",
);

const workgraphRouter = readFileSync(new URL("../src/components/workflows/LegacyWorkgraphAdminRoute.tsx", import.meta.url), "utf8");
for (const expectedLegacyRoute of [
  'path="/workflows"',
  'path="/design/:workflowId"',
  'path="/run"',
  'path="/runs"',
  'path="/runs/:id"',
  'path="/runs/:id/artifacts"',
  'path="/runs/:id/insights"',
]) {
  assert.ok(
    workgraphRouter.includes(expectedLegacyRoute),
    `Legacy Workgraph router must preserve ${expectedLegacyRoute}`,
  );
}

const workbenchConsole = readFileSync(new URL("../src/components/workbench/WorkbenchConsole.tsx", import.meta.url), "utf8");
for (const expectedWorkbenchSurface of [
  "Create Workbench Session",
  "Create session",
  "createWorkbenchSession",
  'workgraphFetch("/blueprint/sessions", {',
  'method: "POST"',
  "Capability ID",
  "Gate Mode",
  "Source URI",
]) {
  assert.ok(
    workbenchConsole.includes(expectedWorkbenchSurface),
    `Workbench console must preserve ${expectedWorkbenchSurface}`,
  );
}

console.log(`legacy Workgraph redirect contract passed (${Object.keys(expected).length} routes)`);
