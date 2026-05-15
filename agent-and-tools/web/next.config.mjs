/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  async rewrites() {
    return [
      // Prompt Composer — owns prompt assembly (M3 cutover from agent-runtime)
      {
        source: "/api/composer/:path*",
        destination: `${process.env.PROMPT_COMPOSER_URL ?? "http://localhost:3004"}/api/v1/:path*`,
      },
      // Runtime (new spec) — must come BEFORE the older /api/agents and /api/tools rules
      {
        source: "/api/runtime/:path*",
        destination: `${process.env.AGENT_RUNTIME_URL ?? "http://localhost:3003"}/api/v1/:path*`,
      },
      {
        source: "/api/iam/:path*",
        destination: `${process.env.IAM_BASE_URL ?? "http://host.docker.internal:8100/api/v1"}/:path*`,
      },
      {
        source: "/api/workgraph/:path*",
        destination: `${process.env.WORKGRAPH_API_URL ?? "http://localhost:8080"}/api/:path*`,
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
      // M21 — audit & governance service (lives outside this compose stack)
      {
        source: "/api/audit-gov/:path*",
        destination: `${process.env.AUDIT_GOV_URL ?? "http://host.docker.internal:8500"}/api/v1/:path*`,
      },
      {
        source: "/api/cf/:path*",
        destination: `${process.env.CONTEXT_FABRIC_URL ?? "http://host.docker.internal:8000"}/:path*`,
      },
    ];
  },
};

export default nextConfig;
