import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const webNodeModules = path.join(process.cwd(), "node_modules");
const workgraphWebSource = new URL("../../workgraph-studio/apps/web/src", import.meta.url).pathname;
const workgraphEngineSource = new URL("../../workgraph-studio/packages/engine/src/index.ts", import.meta.url).pathname;
const codeFoundryWebSource = new URL("../../singularity-code-foundry/apps/code-foundry-web/src", import.meta.url).pathname;
const blueprintWorkbenchSource = new URL("../../workgraph-studio/apps/blueprint-workbench/src", import.meta.url).pathname;
const identityWebSource = new URL("../../UserAndCapabillity/src", import.meta.url).pathname;

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
  transpilePackages: ["workgraph-web"],
  webpack(config) {
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "workgraph-web": workgraphWebSource,
      "@workgraph/engine$": workgraphEngineSource,
      "code-foundry-web": codeFoundryWebSource,
      "blueprint-workbench": blueprintWorkbenchSource,
      "identity-web": identityWebSource,
      "@tanstack/react-query$": require.resolve("@tanstack/react-query"),
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
    ];
  },
  async rewrites() {
    const iamHealthDestination = healthDestination(process.env.IAM_HEALTH_URL, "http://iam-service:8100", "/api/v1/health");
    // Blue Blueprint Workbench cockpit, served SAME-ORIGIN on :5180 — replaces
    // the separate :8085 nginx edge-gateway and the cross-origin auth problem.
    // Mirrors edge-gateway/local.conf: cockpit API_BASE=/workbench/api → the
    // platform-web workgraph proxy; the SPA itself → the cockpit dev server
    // (Vite base /workbench/). In beforeFiles so it shadows the legacy native
    // /workbench page.
    const cockpitDevUrl = (process.env.BLUEPRINT_WORKBENCH_DEV_URL ?? "http://127.0.0.1:5176").replace(/\/+$/, "");
    return {
      beforeFiles: [
        { source: "/workbench/api/:path*", destination: "/api/workgraph/:path*" },
        { source: "/workbench/audit-gov/:path*", destination: "/api/audit-gov/:path*" },
        { source: "/workbench", destination: `${cockpitDevUrl}/workbench/` },
        { source: "/workbench/:path*", destination: `${cockpitDevUrl}/workbench/:path*` },
      ],
      afterFiles: [
      // Prompt Composer is proxied by src/app/api/composer/[...path]/route.ts
      // so Platform Web can attach server-side service auth when no browser
      // bearer is present.
      // Runtime (new spec) — must come BEFORE the older /api/agents and /api/tools rules
      {
        source: "/api/runtime/:path*",
        destination: `${process.env.AGENT_RUNTIME_URL ?? "http://localhost:3003"}/api/v1/:path*`,
      },
      {
        source: "/api/agents/:path*",
        destination: `${process.env.AGENT_SERVICE_URL ?? "http://localhost:3001"}/api/v1/:path*`,
      },
      {
        source: "/api/client-runners/:path*",
        destination: `${process.env.TOOL_SERVICE_URL ?? "http://localhost:3002"}/api/v1/client-runners/:path*`,
      },
      {
        source: "/api/tools/:path*",
        destination: `${process.env.TOOL_SERVICE_URL ?? "http://localhost:3002"}/api/v1/tools/:path*`,
      },
      {
        source: "/api/cf/:path*",
        destination: `${process.env.CONTEXT_FABRIC_URL ?? "http://host.docker.internal:8000"}/:path*`,
      },
      {
        source: "/ops-health/iam",
        destination: iamHealthDestination,
      },
      {
        source: "/ops-health/workgraph-api",
        destination: `${process.env.WORKGRAPH_API_URL ?? "http://workgraph-api:8080"}/health`,
      },
      {
        source: "/ops-health/prompt-composer",
        destination: `${process.env.PROMPT_COMPOSER_URL ?? "http://prompt-composer:3004"}/health`,
      },
      {
        source: "/ops-health/context-api",
        destination: `${process.env.CONTEXT_FABRIC_URL ?? "http://context-api:8000"}/health`,
      },
      {
        source: "/ops-health/agent-runtime",
        destination: `${process.env.AGENT_RUNTIME_URL ?? "http://agent-runtime:3003"}/health`,
      },
      {
        source: "/ops-health/tool-service",
        destination: `${process.env.TOOL_SERVICE_URL ?? "http://tool-service:3002"}/health`,
      },
      {
        source: "/ops-health/agent-service",
        destination: `${process.env.AGENT_SERVICE_URL ?? "http://agent-service:3001"}/health`,
      },
      ],
    };
  },
};

export default nextConfig;
