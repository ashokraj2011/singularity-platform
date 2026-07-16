import { serverEnv } from "./serverRootEnv";
import { SERVICE_DEFINITIONS as RAW_SERVICE_DEFINITIONS } from "./platformServiceDefinitions.mjs";

export type PlatformServiceId =
  | "agent-runtime"
  | "agent-service"
  | "audit-governance"
  | "claim-registry"
  | "context-fabric"
  | "formal-verifier"
  | "iam"
  | "llm-gateway"
  | "mcp-server"
  | "prompt-composer"
  | "tool-service"
  | "workgraph-api";

export type PlatformServiceDefinition = {
  envKey: string;
  localUrl: string;
  dockerUrl: string;
  healthPath: string;
  tokenEnvKeys?: string[];
};

const SERVICE_DEFINITIONS = RAW_SERVICE_DEFINITIONS as Record<PlatformServiceId, PlatformServiceDefinition>;

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function cleanUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimTrailingSlash(trimmed);
}

export function flagEnabled(value: string | null | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

export function platformUsesLocalDefaults(): boolean {
  return Boolean(serverEnv("PG_HOST"));
}

export function platformEnvName(): string {
  return (serverEnv("SINGULARITY_ENV") ?? serverEnv("APP_ENV") ?? process.env.NODE_ENV ?? "development").toLowerCase();
}

export function localDevAllowsAnonymousRead(explicitEnvKey?: string): boolean {
  if (explicitEnvKey) {
    const explicit = serverEnv(explicitEnvKey);
    if (explicit === "true") return false;
    if (explicit === "false") return true;
  }
  return flagEnabled(serverEnv("AUTH_OPTIONAL")) && !["production", "prod", "staging", "perf"].includes(platformEnvName());
}

export function platformService(serviceId: PlatformServiceId): PlatformServiceDefinition {
  return SERVICE_DEFINITIONS[serviceId];
}

export function platformServiceUrl(serviceId: PlatformServiceId, fallbackOverride?: string): string {
  const service = platformService(serviceId);
  const fallback = fallbackOverride ?? (platformUsesLocalDefaults() ? service.localUrl : service.dockerUrl);
  return trimTrailingSlash(serverEnv(service.envKey, fallback) ?? fallback);
}

export function configuredPlatformServiceUrl(serviceId: PlatformServiceId, ...extraEnvKeys: string[]): string | null {
  const service = platformService(serviceId);
  for (const envKey of [service.envKey, ...extraEnvKeys]) {
    const value = cleanUrl(serverEnv(envKey));
    if (value) return value;
  }
  return null;
}

export function platformServiceHealthUrl(serviceId: PlatformServiceId, healthPath?: string): string {
  const service = platformService(serviceId);
  const path = healthPath ?? service.healthPath;
  return `${platformServiceUrl(serviceId)}${path.startsWith("/") ? path : `/${path}`}`;
}

export function platformServiceToken(serviceId: PlatformServiceId): string | null {
  for (const envKey of platformService(serviceId).tokenEnvKeys ?? []) {
    const value = serverEnv(envKey)?.trim();
    if (value) return value;
  }
  return null;
}

export function bearerHeaders(token: string | null | undefined): HeadersInit {
  const bearer = token?.trim();
  return bearer ? { Authorization: bearer.startsWith("Bearer ") ? bearer : `Bearer ${bearer}` } : {};
}

export function serviceBearerHeaders(serviceId: PlatformServiceId): HeadersInit {
  return bearerHeaders(platformServiceToken(serviceId));
}

export function contextFabricStatusHeaders(): HeadersInit {
  const token = platformServiceToken("context-fabric");
  return token ? { "X-Service-Token": token } : {};
}

export function iamApiBase(): string {
  const raw = platformServiceUrl("iam");
  return raw.endsWith("/api/v1") ? raw : `${raw}/api/v1`;
}
