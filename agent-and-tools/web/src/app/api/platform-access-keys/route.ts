import { NextRequest, NextResponse } from "next/server";
import { platformWebDevelopmentSecretReason, platformWebProductionEnv } from "@/lib/serverEnvGuard";
import { requireVerifiedCallerBearer } from "../_proxy";

export const dynamic = "force-dynamic";

type AccessKeyStatus = "ready" | "missing" | "default" | "weak" | "optional" | "not_visible";
type AccessKeySeverity = "ok" | "warn" | "error" | "info";
type AccessKeyKind = "password" | "service_token" | "bearer_token" | "api_key" | "provider_token" | "scope";
type AccessKeyGroup = "identity" | "platform" | "runtime" | "providers";

type AccessKeyConfig = {
  id: string;
  label: string;
  description: string;
  group: AccessKeyGroup;
  owner: string;
  kind: AccessKeyKind;
  envKeys: string[];
  scope: string;
  usedBy: string[];
  rotation: string;
  required: boolean;
  productionRequired?: boolean;
  remoteCapable: boolean;
  visibleToPlatformWeb: boolean;
  minLength?: number;
  requiredWhenEnv?: string[];
};

type AccessKeyRow = Omit<AccessKeyConfig, "minLength" | "requiredWhenEnv"> & {
  configured: boolean;
  configuredEnvKey: string | null;
  requiredNow: boolean;
  status: AccessKeyStatus;
  severity: AccessKeySeverity;
  message: string;
};

const ACCESS_KEYS: AccessKeyConfig[] = [
  {
    id: "iam-bootstrap-password",
    label: "IAM bootstrap admin password",
    description: "Local super-admin bootstrap credential used for first login and emergency local administration.",
    group: "identity",
    owner: "IAM Service",
    kind: "password",
    envKeys: ["IAM_BOOTSTRAP_PASSWORD", "LOCAL_SUPER_ADMIN_PASSWORD"],
    scope: "Local admin sign-in only",
    usedBy: ["Identity login", "Bare-metal bootstrap", "Local development"],
    rotation: "Rotate after first setup and never use a development default in shared or production environments.",
    required: true,
    productionRequired: true,
    remoteCapable: false,
    visibleToPlatformWeb: true,
    minLength: 12,
  },
  {
    id: "workgraph-proxy-token",
    label: "Workgraph proxy service token",
    description: "Server-side token that lets Platform Web call Workgraph APIs without exposing service credentials to the browser.",
    group: "platform",
    owner: "Platform Web",
    kind: "service_token",
    envKeys: ["WORKGRAPH_PROXY_SERVICE_TOKEN"],
    scope: "platform-web -> workgraph-api",
    usedBy: ["Workflow manager", "React Flow designer", "Runs dashboard", "WorkItems"],
    rotation: "Mint through IAM as service_name=platform-web with the required Workgraph scopes.",
    required: true,
    productionRequired: true,
    remoteCapable: false,
    visibleToPlatformWeb: true,
    minLength: 32,
  },
  {
    id: "prompt-composer-token",
    label: "Prompt Composer service token",
    description: "Server-side token used when Platform Web proxies prompt profile and composition operations.",
    group: "platform",
    owner: "Prompt Composer",
    kind: "service_token",
    envKeys: ["PROMPT_COMPOSER_SERVICE_TOKEN"],
    scope: "platform-web -> prompt-composer",
    usedBy: ["Prompt Workbench", "Agent Studio", "Workflow stage prompt previews"],
    rotation: "Use a dedicated service token or the IAM-minted platform-web service token when the same scopes are valid.",
    required: true,
    productionRequired: true,
    remoteCapable: false,
    visibleToPlatformWeb: true,
    minLength: 32,
  },
  {
    id: "tenant-scope",
    label: "IAM service token tenant scope",
    description: "Tenant allow-list attached to service-token based backend calls.",
    group: "identity",
    owner: "IAM Service",
    kind: "scope",
    envKeys: ["IAM_SERVICE_TOKEN_TENANT_IDS"],
    scope: "Tenant isolation guard",
    usedBy: ["Workgraph proxy", "Production tenant isolation", "Service-token validation"],
    rotation: "Keep in sync with service JWT tenant_ids when tenant-scoped runtime is enabled.",
    required: false,
    productionRequired: false,
    remoteCapable: false,
    visibleToPlatformWeb: true,
  },
  {
    id: "mcp-bearer-token",
    label: "MCP HTTP debug bearer",
    description: "Bearer credential for direct MCP HTTP fallback and diagnostics. Normal runtime traffic uses the Runtime Bridge token.",
    group: "runtime",
    owner: "MCP Runtime",
    kind: "bearer_token",
    envKeys: ["MCP_BEARER_TOKEN", "MCP_DEMO_BEARER_TOKEN"],
    scope: "Context Fabric debug fallback -> MCP HTTP",
    usedBy: ["MCP runtime HTTP debug", "Tool execution fallback"],
    rotation: "Use a long random token only when RUNTIME_HTTP_FALLBACK_ENABLED=true.",
    required: false,
    requiredWhenEnv: ["MCP_SERVER_URL"],
    remoteCapable: true,
    visibleToPlatformWeb: true,
    minLength: 16,
  },
  {
    id: "runtime-bridge-token",
    label: "Runtime Bridge token",
    description: "IAM-signed runtime/device JWT used by MCP runtimes to dial into Context Fabric over WebSocket.",
    group: "runtime",
    owner: "Context Fabric / IAM",
    kind: "bearer_token",
    envKeys: ["SINGULARITY_RUNTIME_TOKEN", "SINGULARITY_DEVICE_TOKEN"],
    scope: "MCP runtime -> Context Fabric Runtime Bridge",
    usedBy: ["Runtime Bridge", "MCP runtime dial-in", "Laptop bridge compatibility"],
    rotation: "Mint from IAM as a runtime/device token; keep it only on the runtime host.",
    required: false,
    remoteCapable: true,
    visibleToPlatformWeb: false,
    minLength: 32,
  },
  {
    id: "llm-gateway-bearer",
    label: "LLM Gateway bearer",
    description: "Optional bearer credential for a separately deployed model gateway.",
    group: "runtime",
    owner: "LLM Gateway",
    kind: "bearer_token",
    envKeys: ["LLM_GATEWAY_BEARER"],
    scope: "Platform/runtime -> llm-gateway",
    usedBy: ["LLM Settings", "MCP runtime", "Agent Runtime distillation"],
    rotation: "Set only when the deployed LLM Gateway requires bearer authentication.",
    required: false,
    remoteCapable: true,
    visibleToPlatformWeb: true,
    minLength: 16,
  },
  {
    id: "context-fabric-service-token",
    label: "Context Fabric service token",
    description: "Backend service token for context, memory, knowledge, and execution receipt APIs.",
    group: "platform",
    owner: "Context Fabric",
    kind: "service_token",
    envKeys: ["CONTEXT_FABRIC_SERVICE_TOKEN"],
    scope: "platform services -> context-api",
    usedBy: ["Prompt Composer", "Workgraph API", "Agent Runtime", "MCP runtime"],
    rotation: "Rotate through the deployment config and restart services that call Context Fabric.",
    required: true,
    productionRequired: true,
    remoteCapable: true,
    visibleToPlatformWeb: false,
    minLength: 32,
  },
  {
    id: "audit-governance-token",
    label: "Audit Governance service token",
    description: "Credential used to push audit packs, receipts, learning events, and governance evidence.",
    group: "platform",
    owner: "Audit Governance",
    kind: "service_token",
    envKeys: ["AUDIT_GOV_SERVICE_TOKEN", "LEARNING_SERVICE_TOKEN"],
    scope: "platform services -> audit-governance",
    usedBy: ["Agent Runtime", "Prompt Composer", "Tool Service", "Code Foundry"],
    rotation: "Rotate when audit governance is connected outside the local development stack.",
    required: false,
    remoteCapable: true,
    visibleToPlatformWeb: true,
    minLength: 32,
  },
  {
    id: "jwt-secret",
    label: "JWT signing secret",
    description: "Backend signing secret for service and user JWTs.",
    group: "identity",
    owner: "IAM and API services",
    kind: "service_token",
    envKeys: ["JWT_SECRET"],
    scope: "Token signing and verification",
    usedBy: ["IAM Service", "Agent Service", "Tool Service", "Agent Runtime", "Workgraph API"],
    rotation: "Rotate with coordinated service restarts and token invalidation.",
    required: true,
    productionRequired: true,
    remoteCapable: false,
    visibleToPlatformWeb: false,
    minLength: 32,
  },
  {
    id: "github-token",
    label: "GitHub provider token",
    description: "Optional provider token for source import, repo operations, and Git-backed SDLC agents.",
    group: "providers",
    owner: "External provider",
    kind: "provider_token",
    envKeys: ["GITHUB_TOKEN", "GH_TOKEN", "MCP_GIT_TOKEN"],
    scope: "GitHub API and git operations",
    usedBy: ["MCP Runtime", "Code Foundry", "Provider/API skill manifests"],
    rotation: "Use a least-privilege PAT or GitHub App token; keep it on the runtime that performs git/API work.",
    required: false,
    remoteCapable: true,
    visibleToPlatformWeb: false,
    minLength: 20,
  },
  {
    id: "copilot-token",
    label: "Copilot CLI token",
    description: "Optional token for Copilot-backed workflow execution from the local or remote runtime.",
    group: "providers",
    owner: "External provider",
    kind: "provider_token",
    envKeys: ["COPILOT_TOKEN"],
    scope: "Copilot CLI / model provider",
    usedBy: ["Copilot workflow runner", "LLM Gateway", "MCP Runtime"],
    rotation: "Store in the LLM gateway or runtime bridge secret file, not in browser-visible config.",
    required: false,
    remoteCapable: true,
    visibleToPlatformWeb: false,
    minLength: 16,
  },
  {
    id: "copilot-provider-key",
    label: "Copilot BYOK provider key",
    description: "Optional BYOK model-provider credential for Copilot-style SDLC execution.",
    group: "providers",
    owner: "External provider",
    kind: "api_key",
    envKeys: ["COPILOT_PROVIDER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"],
    scope: "LLM Gateway provider calls",
    usedBy: ["LLM Gateway", "MCP Runtime", "Copilot workflow runner"],
    rotation: "Keep provider keys inside the LLM Gateway deployment boundary.",
    required: false,
    remoteCapable: true,
    visibleToPlatformWeb: false,
    minLength: 16,
  },
];

function envEntry(keys: string[]): { key: string; value: string } | null {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return { key, value };
  }
  return null;
}

function hasAnyEnv(keys: string[]): boolean {
  return keys.some((key) => Boolean(process.env[key]?.trim()));
}

function requiredNow(config: AccessKeyConfig, production: boolean): boolean {
  if (config.required || (production && config.productionRequired)) return true;
  return (config.requiredWhenEnv ?? []).some((key) => Boolean(process.env[key]?.trim()));
}

function classify(config: AccessKeyConfig, productionSignal: string | null): AccessKeyRow {
  const production = Boolean(productionSignal);
  const required = requiredNow(config, production);
  const active = envEntry(config.envKeys);
  const configured = Boolean(active);
  const { minLength: _minLength, requiredWhenEnv: _requiredWhenEnv, ...publicConfig } = config;
  const base = {
    ...publicConfig,
    configured,
    configuredEnvKey: active?.key ?? null,
    requiredNow: required,
  };

  if (!configured) {
    if (!config.visibleToPlatformWeb && !required) {
      return {
        ...base,
        status: "not_visible",
        severity: "info",
        message: "This credential is owned by a runtime/provider boundary and is not injected into Platform Web.",
      };
    }
    if (!config.visibleToPlatformWeb && required) {
      return {
        ...base,
        status: "not_visible",
        severity: production ? "warn" : "info",
        message: production
          ? "Platform Web cannot inspect this backend-owned required secret. Run the deployment env audit on the host."
          : "Backend-owned secret is not injected into Platform Web; use the deployment env audit for its exact readiness.",
      };
    }
    return {
      ...base,
      status: required ? "missing" : "optional",
      severity: required ? "error" : "info",
      message: required
        ? `${config.envKeys.join(" or ")} is required for this deployment boundary.`
        : "Optional credential is not configured.",
    };
  }

  const defaultReason = platformWebDevelopmentSecretReason(active?.value);
  if (defaultReason) {
    return {
      ...base,
      status: "default",
      severity: production ? "error" : "warn",
      message: production
        ? `Configured value is a ${defaultReason} and blocks production-class deployment.`
        : `Configured value is a ${defaultReason}; acceptable for local development only.`,
    };
  }

  if (config.minLength && active && active.value.length < config.minLength) {
    return {
      ...base,
      status: "weak",
      severity: required || production ? "error" : "warn",
      message: "Configured value is shorter than the platform minimum for this secret class.",
    };
  }

  return {
    ...base,
    status: "ready",
    severity: "ok",
    message: config.visibleToPlatformWeb
      ? "Configured in the Platform Web environment."
      : "Configured but classified server-side only; raw value is never returned.",
  };
}

export async function GET(request: NextRequest) {
  const authFailure = await requireVerifiedCallerBearer(request, "Platform access keys");
  if (authFailure) return authFailure;

  const productionSignal = platformWebProductionEnv();
  const keys = ACCESS_KEYS.map((config) => classify(config, productionSignal));
  const defaultOrWeak = keys.filter((key) => key.status === "default" || key.status === "weak");
  const missingRequired = keys.filter((key) => key.status === "missing");
  const notVisible = keys.filter((key) => key.status === "not_visible");
  const productionBlockers = keys.filter((key) => key.severity === "error");

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    environment: {
      productionClass: Boolean(productionSignal),
      productionSignal,
      appEnv: process.env.APP_ENV ?? null,
      singularityEnv: process.env.SINGULARITY_ENV ?? null,
      rawSecretsReturned: false,
    },
    summary: {
      total: keys.length,
      configured: keys.filter((key) => key.configured).length,
      configuredVisibleToPlatformWeb: keys.filter((key) => key.configured && key.visibleToPlatformWeb).length,
      missingRequired: missingRequired.length,
      optionalNotConfigured: keys.filter((key) => key.status === "optional").length,
      defaultOrWeak: defaultOrWeak.length,
      notVisible: notVisible.length,
      productionBlockers: productionBlockers.length,
      providerCredentialsPresent: ACCESS_KEYS.filter((key) => key.group === "providers").some((key) => hasAnyEnv(key.envKeys)),
    },
    keys,
  });
}
