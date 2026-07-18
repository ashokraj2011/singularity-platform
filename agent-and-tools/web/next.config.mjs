import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { SERVICE_DEFINITIONS, defaultServiceUrl } from "./src/lib/platformServiceDefinitions.mjs";

const require = createRequire(import.meta.url);
const webNodeModules = path.join(process.cwd(), "node_modules");
const workgraphWebSource = new URL("../../workgraph-studio/apps/web/src", import.meta.url).pathname;
const workgraphEngineSource = new URL("../../workgraph-studio/packages/engine/src/index.ts", import.meta.url).pathname;
const blueprintWorkbenchSource = new URL("../../workgraph-studio/apps/blueprint-workbench/src", import.meta.url).pathname;

function stripEnvQuotes(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadRootEnv() {
  const candidates = [
    path.resolve(process.cwd(), "../../.env.local"),
    path.resolve(process.cwd(), "../.env.local"),
    path.resolve(process.cwd(), ".env.local"),
  ];
  const env = {};
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    for (const rawLine of fs.readFileSync(candidate, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
      const eq = normalized.indexOf("=");
      if (eq <= 0) continue;
      const key = normalized.slice(0, eq).trim();
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
      const value = stripEnvQuotes(normalized.slice(eq + 1)).replace(/\$([A-Z0-9_]+)/g, (_match, ref) => env[ref] ?? process.env[ref] ?? "");
      env[key] = value;
      if (process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = value;
      }
    }
    break;
  }
  return env;
}

const rootEnv = loadRootEnv();

function configEnv(key, fallback) {
  return process.env[key] || rootEnv[key] || fallback;
}

function localDefaults() {
  return Boolean(configEnv("PG_HOST", ""));
}

function serviceUrl(serviceId, local) {
  const service = SERVICE_DEFINITIONS[serviceId];
  return configEnv(service.envKey, defaultServiceUrl(serviceId, local));
}

function healthDestination(value, defaultBase, path) {
  const raw = (value || defaultBase).replace(/\/+$/, "");
  return raw.endsWith(path) ? raw : `${raw}${path}`;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    externalDir: true,
  },
  transpilePackages: ["workgraph-web", "blueprint-workbench"],
  webpack(config) {
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "workgraph-web": workgraphWebSource,
      "@workgraph/engine$": workgraphEngineSource,
      "blueprint-workbench": blueprintWorkbenchSource,
      "@tanstack/react-query$": require.resolve("@tanstack/react-query"),
      // workgraph-web source (aliased in) imports next/navigation now that its
      // pages are native Next routes — resolve it from platform-web's deps.
      "next/navigation$": require.resolve("next/navigation"),
      "@monaco-editor/react$": require.resolve("@monaco-editor/react"),
      "react-diff-viewer-continued$": require.resolve("react-diff-viewer-continued"),
      "react-markdown$": require.resolve("react-markdown"),
      "remark-gfm$": require.resolve("remark-gfm"),
      "motion/react": require.resolve("motion/react"),
      "reactflow$": require.resolve("reactflow"),
      "zustand$": require.resolve("zustand"),
      "zustand/middleware$": require.resolve("zustand/middleware"),
      "zustand/shallow$": require.resolve("zustand/shallow"),
      "zustand/vanilla$": require.resolve("zustand/vanilla"),
    };
    config.resolve.modules = [webNodeModules, ...(config.resolve.modules ?? [])];
    return config;
  },
  async redirects() {
    return [
      { source: "/agent-studio", destination: "/agents/studio", permanent: false },
      { source: "/agent/agent-studio", destination: "/agents/studio", permanent: false },
      { source: "/agent", destination: "/agents", permanent: false },
      { source: "/agent/:path*", destination: "/agents/:path*", permanent: false },
      { source: "/iam", destination: "/identity", permanent: false },
      { source: "/iam/:path*", destination: "/identity/:path*", permanent: false },
      { source: "/agent-templates", destination: "/agents/studio", permanent: false },
      { source: "/agent-templates/:path*", destination: "/agents/studio", permanent: false },
      { source: "/login", destination: "/identity/login", permanent: false },
      { source: "/context-picker", destination: "/identity/dashboard", permanent: false },
      { source: "/dashboard", destination: "/", permanent: false },
      { source: "/design/:workflowId", destination: "/workflows/design/:workflowId", permanent: false },
      { source: "/planner", destination: "/workflows/planner", permanent: false },
      { source: "/runtime", destination: "/workflows/inbox", permanent: false },
      { source: "/runtime/history", destination: "/workflows/history", permanent: false },
      { source: "/runtime/work/:kind/:id", destination: "/workflows/work/:kind/:id", permanent: false },
      { source: "/templates", destination: "/workflows/templates", permanent: false },
      { source: "/templates/:path*", destination: "/workflows/templates", permanent: false },
      { source: "/workflow", destination: "/workflows", permanent: false },
      { source: "/workflow/dashboard", destination: "/", permanent: false },
      { source: "/workflow/login", destination: "/identity/login", permanent: false },
      { source: "/workflow/context-picker", destination: "/identity/dashboard", permanent: false },
      { source: "/workflow/planner", destination: "/workflows/planner", permanent: false },
      { source: "/workflow/runtime", destination: "/workflows/inbox", permanent: false },
      { source: "/workflow/runtime/history", destination: "/workflows/history", permanent: false },
      { source: "/workflow/runtime/work/:kind/:id", destination: "/workflows/work/:kind/:id", permanent: false },
      { source: "/workflow/run", destination: "/workflows/run", permanent: false },
      { source: "/workflow/workflows", destination: "/workflows/templates", permanent: false },
      { source: "/workflow/templates", destination: "/workflows/templates", permanent: false },
      { source: "/workflow/node-types", destination: "/workflows/node-types", permanent: false },
      { source: "/workflow/design/:workflowId", destination: "/workflows/design/:workflowId", permanent: false },
      { source: "/workflow/runs", destination: "/runs", permanent: false },
      { source: "/workflow/runs/:id", destination: "/runs/:id", permanent: false },
      { source: "/workflow/runs/:id/artifacts", destination: "/runs/:id/artifacts", permanent: false },
      { source: "/workflow/runs/:id/insights", destination: "/runs/:id/insights", permanent: false },
      { source: "/workflow/artifacts-explorer", destination: "/workflows/artifacts/explorer", permanent: false },
      { source: "/workflow/artifacts", destination: "/workflows/artifacts", permanent: false },
      { source: "/workflow/artifacts/:id", destination: "/workflows/artifacts/:id", permanent: false },
      { source: "/workflow/mission-control/:id", destination: "/runs/:id/insights", permanent: false },
      { source: "/workflow/play/new", destination: "/workflows/run", permanent: false },
      { source: "/workflow/play/:runId", destination: "/runs/:runId", permanent: false },
      { source: "/workflow/connectors", destination: "/workflows/connectors", permanent: false },
      { source: "/workflow/llm-routing", destination: "/llm-settings", permanent: false },
      { source: "/workflow/audit", destination: "/audit", permanent: false },
      { source: "/workflow/curation", destination: "/audit/curation", permanent: false },
      { source: "/workflow/metadata", destination: "/workflows/metadata", permanent: false },
      { source: "/workflow/history", destination: "/workflows/history", permanent: false },
      { source: "/workflow/team-variables", destination: "/identity/variables", permanent: false },
      { source: "/workflow/global-variables", destination: "/identity/variables", permanent: false },
      { source: "/workflow/:instanceId", destination: "/runs/:instanceId", permanent: false },
      { source: "/workflows/workflows", destination: "/workflows/templates", permanent: false },
      { source: "/workflows/runs", destination: "/runs", permanent: false },
      { source: "/workflows/runs/:id", destination: "/runs/:id", permanent: false },
      { source: "/history", destination: "/workflows/history", permanent: false },
      { source: "/node-types", destination: "/workflows/node-types", permanent: false },
      { source: "/artifacts-explorer", destination: "/workflows/artifacts/explorer", permanent: false },
      { source: "/artifacts", destination: "/workflows/artifacts", permanent: false },
      { source: "/artifacts/:path*", destination: "/workflows/artifacts/:path*", permanent: false },
      { source: "/mission-control/:id", destination: "/runs/:id/insights", permanent: false },
      { source: "/play/new", destination: "/workflows/run", permanent: false },
      { source: "/play/:runId", destination: "/runs/:runId", permanent: false },
      { source: "/connectors", destination: "/workflows/connectors", permanent: false },
      { source: "/metadata", destination: "/workflows/metadata", permanent: false },
      { source: "/llm-routing", destination: "/llm-settings", permanent: false },
      { source: "/curation", destination: "/audit/curation", permanent: false },
      { source: "/team-variables", destination: "/identity/variables", permanent: false },
      { source: "/global-variables", destination: "/identity/variables", permanent: false },
      // Legacy Project Studio now folds into Synthesis. Keep backend /studio APIs,
      // but do not expose a second user-facing workspace.
      { source: "/studio", destination: "/synthesis/hub", permanent: false },
      { source: "/studio/:projectId", destination: "/synthesis/overview?project=:projectId", permanent: false },
      // The green native workbench console (/workbench/<view>) was retired; the
      // blue in-process cockpit at /workbench handles every view internally.
      { source: "/workbench/:view(cockpit|artifacts|stage-chat|code-review|audit|loop-theater|milestones|governance|export)", destination: "/workbench", permanent: false },
    ];
  },
  async rewrites() {
    const local = localDefaults();
    const iamDefault = serviceUrl("iam", local).replace(/\/api\/v1\/?$/, "");
    const iamHealthDestination = healthDestination(configEnv("IAM_HEALTH_URL", ""), iamDefault, "/api/v1/health");
    // Blue Blueprint Workbench cockpit runs IN-PROCESS as the Next /workbench
    // route (slice 2 — no separate :5176 dev server, no :8085 gateway). Only the
    // cockpit's own API paths still need proxying to the backends, same as the
    // old edge-gateway: API_BASE=/workbench/api → workgraph proxy; the live SSE
    // stream /workbench/audit-gov → audit-gov.
    return {
      beforeFiles: [
        { source: "/workbench/api/:path*", destination: "/api/workgraph/:path*" },
        { source: "/workbench/audit-gov/:path*", destination: "/api/audit-gov/:path*" },
      ],
      afterFiles: [
      // Prompt Composer is proxied by src/app/api/composer/[...path]/route.ts
      // so Platform Web can attach server-side service auth when no browser
      // bearer is present.
      // Runtime (new spec) — must come BEFORE the older /api/agents and /api/tools rules
      {
        source: "/api/runtime/:path*",
        destination: `${serviceUrl("agent-runtime", local)}/api/v1/:path*`,
      },
      {
        source: "/api/agents/:path*",
        destination: `${serviceUrl("agent-service", local)}/api/v1/:path*`,
      },
      {
        source: "/api/client-runners/:path*",
        destination: `${serviceUrl("tool-service", local)}/api/v1/client-runners/:path*`,
      },
      {
        source: "/api/tools/:path*",
        destination: `${serviceUrl("tool-service", local)}/api/v1/tools/:path*`,
      },
      {
        source: "/api/cf/:path*",
        destination: `${serviceUrl("context-fabric", local)}/:path*`,
      },
      {
        source: "/ops-health/iam",
        destination: iamHealthDestination,
      },
      {
        source: "/ops-health/workgraph-api",
        destination: `${serviceUrl("workgraph-api", local)}/health`,
      },
      {
        source: "/ops-health/prompt-composer",
        destination: `${serviceUrl("prompt-composer", local)}/health`,
      },
      {
        source: "/ops-health/context-api",
        destination: `${serviceUrl("context-fabric", local)}/health`,
      },
      {
        source: "/ops-health/agent-runtime",
        destination: `${serviceUrl("agent-runtime", local)}/health`,
      },
      {
        source: "/ops-health/tool-service",
        destination: `${serviceUrl("tool-service", local)}/health`,
      },
      {
        source: "/ops-health/agent-service",
        destination: `${serviceUrl("agent-service", local)}/health`,
      },
      ],
    };
  },
};

export default nextConfig;
