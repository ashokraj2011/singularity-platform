import { createHmac, timingSafeEqual } from "crypto";
import { isProductionClassEnv } from "@agentandtools/shared";

export type ManifestSignatureMode = "auto" | "disabled" | "required";

export type ManifestVerificationInput = {
  body: string;
  signature?: string | null;
  keyId?: string | null;
  trustedKeys?: string;
  mode?: ManifestSignatureMode;
  nodeEnv?: string;
};

export type ManifestEnvelopeValidationInput = {
  manifest: Record<string, unknown>;
  trustedKeys?: string;
  mode?: ManifestSignatureMode;
  nodeEnv?: string;
  maxTtlSeconds?: number;
  now?: Date;
};

export function parseTrustedManifestKeys(raw?: string): Record<string, string> {
  const value = raw?.trim();
  if (!value) return {};
  if (value.startsWith("{")) {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
    );
  }
  return Object.fromEntries(
    value
      .split(",")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const separator = pair.indexOf(":");
        if (separator <= 0) throw new Error("trusted provider manifest keys must be JSON or keyId:secret pairs");
        return [pair.slice(0, separator), pair.slice(separator + 1)];
      }),
  );
}

export function trustedManifestKeyStrengthIssues(raw?: string, minLength = 32): string[] {
  const trustedKeys = parseTrustedManifestKeys(raw);
  return Object.entries(trustedKeys)
    .filter(([, secret]) => secret.trim().length < minLength)
    .map(([keyId]) => `provider manifest key ${keyId} must be at least ${minLength} characters`);
}

export function manifestSignatureRequired(input: {
  mode?: ManifestSignatureMode;
  trustedKeys?: string;
  nodeEnv?: string;
}): boolean {
  const mode = input.mode ?? "auto";
  if (mode === "required") return true;
  if (mode === "disabled") return false;
  return isProductionClassEnv(input.nodeEnv ?? process.env.NODE_ENV ?? "development") || Object.keys(parseTrustedManifestKeys(input.trustedKeys)).length > 0;
}

function normalizeSignature(signature?: string | null): string | null {
  const value = signature?.trim();
  if (!value) return null;
  return value.startsWith("sha256=") ? value.slice("sha256=".length) : value;
}

export function signProviderManifest(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function verifyProviderManifestSignature(input: ManifestVerificationInput): void {
  const required = manifestSignatureRequired(input);
  if ((input.mode ?? "auto") === "disabled") return;
  const trustedKeys = parseTrustedManifestKeys(input.trustedKeys);
  const keyId = input.keyId?.trim();
  const signature = normalizeSignature(input.signature);

  if (!keyId || !signature) {
    if (required) throw new Error("provider manifest signature required");
    return;
  }

  const secret = trustedKeys[keyId];
  if (!secret) throw new Error(`provider manifest key is not trusted: ${keyId}`);

  const expected = signProviderManifest(input.body, secret);
  const actualBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error("provider manifest signature verification failed");
  }
}

function firstString(manifest: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = manifest[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function parseManifestDate(label: string, value?: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`provider manifest ${label} is not a valid timestamp`);
  return parsed;
}

function manifestCapabilities(manifest: Record<string, unknown>): Array<Record<string, unknown>> {
  const topLevel = Array.isArray(manifest.capabilities)
    ? manifest.capabilities.filter((capability): capability is Record<string, unknown> => (
      Boolean(capability) && typeof capability === "object" && !Array.isArray(capability)
    ))
    : [];
  const skills = Array.isArray(manifest.skills)
    ? manifest.skills.filter((skill): skill is Record<string, unknown> => (
      Boolean(skill) && typeof skill === "object" && !Array.isArray(skill)
    ))
    : [];
  const nested = skills.flatMap((skill) => Array.isArray(skill.capabilities)
    ? skill.capabilities.filter((capability): capability is Record<string, unknown> => (
      Boolean(capability) && typeof capability === "object" && !Array.isArray(capability)
    ))
    : []);
  return [...topLevel, ...nested];
}

function capabilityId(capability: Record<string, unknown>, index: number): string | undefined {
  const raw = capability.id ?? capability.capability_id ?? capability.name;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  return raw.trim() || `capability-${index + 1}`;
}

function invocationEndpoint(capability: Record<string, unknown>): string | undefined {
  const raw = capability.endpoint ?? capability.invocation_endpoint ?? capability.invocationEndpoint;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function validateProviderManifestEnvelope(input: ManifestEnvelopeValidationInput): void {
  const required = manifestSignatureRequired(input);
  const now = input.now ?? new Date();
  const maxTtlSeconds = input.maxTtlSeconds ?? 30 * 24 * 60 * 60;
  const manifest = input.manifest;

  const version = firstString(manifest, ["version", "manifest_version", "manifestVersion"]);
  const issuedAt = parseManifestDate("issuedAt", firstString(manifest, ["issuedAt", "issued_at"]));
  const expiresAt = parseManifestDate("expiresAt", firstString(manifest, ["expiresAt", "expires_at", "validUntil", "valid_until"]));

  if (required && !version) throw new Error("signed provider manifest must include version or manifest_version");
  if (required && !expiresAt) throw new Error("signed provider manifest must include expiresAt");
  if (expiresAt && expiresAt.getTime() <= now.getTime()) throw new Error("provider manifest expired");
  if (issuedAt && issuedAt.getTime() > now.getTime() + 5 * 60 * 1000) {
    throw new Error("provider manifest issuedAt is in the future");
  }
  if (issuedAt && expiresAt) {
    const ttlSeconds = Math.ceil((expiresAt.getTime() - issuedAt.getTime()) / 1000);
    if (ttlSeconds > maxTtlSeconds) {
      throw new Error(`provider manifest validity window exceeds ${maxTtlSeconds} seconds`);
    }
  }

  const seen = new Set<string>();
  for (const [index, capability] of manifestCapabilities(manifest).entries()) {
    const id = capabilityId(capability, index);
    if (id) {
      if (seen.has(id)) throw new Error(`provider manifest has duplicate capability id: ${id}`);
      seen.add(id);
    }
    const endpoint = invocationEndpoint(capability);
    if (required && endpoint?.startsWith("http://")) {
      throw new Error(`provider manifest capability ${id ?? index + 1} uses insecure invocation endpoint`);
    }
  }
}
