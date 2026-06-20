export const CAPABILITY_PERMISSIONS = ["read", "invoke", "configure", "edit"] as const;
export type CapabilityPermission = typeof CAPABILITY_PERMISSIONS[number];

export interface ToolCapabilityMetadata {
  capability_id?: string;
  capability_permissions: CapabilityPermission[];
  read_only: boolean;
  provider_locked: boolean;
  provider_id?: string;
  provider_manifest_version?: string;
  provider_manifest_digest?: string;
  provider_manifest_signature_key_id?: string;
  provider_manifest_signed?: boolean;
  source: "local" | "provider" | "runtime" | "provider_manifest" | "url_document" | "uploaded_document";
  source_type: string;
  source_ref?: string;
}

const PERMISSION_SET = new Set<string>(CAPABILITY_PERMISSIONS);
const MUTATION_TOOLS = new Set([
  "apply_patch",
  "replace_text",
  "replace_range",
  "write_file",
  "git_commit",
  "finish_work_branch",
  "create_jira_issue",
  "send_slack_message",
  "send_email",
  "send_teams_message",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizePermissions(raw: unknown, fallback: CapabilityPermission[]): CapabilityPermission[] {
  let values: unknown = raw;
  if (isRecord(values)) {
    values = Object.entries(values)
      .filter(([, enabled]) => Boolean(enabled))
      .map(([name]) => name);
  }
  if (!Array.isArray(values)) return fallback;

  const normalized: CapabilityPermission[] = [];
  for (const item of values) {
    const permission = String(item).trim().toLowerCase();
    if (PERMISSION_SET.has(permission) && !normalized.includes(permission as CapabilityPermission)) {
      normalized.push(permission as CapabilityPermission);
    }
  }
  return normalized.length ? normalized : fallback;
}

function defaultPermissions(toolName: string): CapabilityPermission[] {
  return MUTATION_TOOLS.has(toolName) ? ["read", "invoke", "edit"] : ["read", "invoke"];
}

export function capabilityMetadataForTool(
  tool: Record<string, unknown>,
  requestedCapabilityId?: string,
): ToolCapabilityMetadata {
  const metadata = isRecord(tool.metadata) ? tool.metadata : {};
  const runtime = isRecord(tool.runtime) ? tool.runtime : {};
  const toolName = String(tool.tool_name ?? tool.name ?? "");
  const fallback = defaultPermissions(toolName);
  const providerId =
    stringOrUndefined(metadata.provider_id) ??
    stringOrUndefined(metadata.providerId) ??
    stringOrUndefined(runtime.provider_id) ??
    stringOrUndefined(runtime.providerId);
  const sourceRaw =
    stringOrUndefined(metadata.source) ??
    stringOrUndefined(metadata.source_type) ??
    stringOrUndefined(metadata.sourceType) ??
    (providerId ? "provider" : undefined);
  const source = sourceRaw === "provider" || sourceRaw === "runtime" || sourceRaw === "local" ||
    sourceRaw === "provider_manifest" || sourceRaw === "url_document" || sourceRaw === "uploaded_document"
    ? sourceRaw
    : "local";
  const sourceType =
    stringOrUndefined(metadata.source_type) ??
    stringOrUndefined(metadata.sourceType) ??
    (source === "provider" ? "provider_manifest" : source);
  const sourceRef =
    stringOrUndefined(metadata.source_ref) ??
    stringOrUndefined(metadata.sourceRef) ??
    stringOrUndefined(metadata.manifest_url) ??
    stringOrUndefined(metadata.manifestUrl) ??
    stringOrUndefined(runtime.endpoint_url) ??
    stringOrUndefined(runtime.endpointUrl);
  const permissions = normalizePermissions(
    metadata.capability_permissions ?? metadata.capabilityPermissions ?? metadata.permissions,
    fallback,
  );
  const readOnly = typeof metadata.read_only === "boolean"
    ? metadata.read_only
    : typeof metadata.readOnly === "boolean"
      ? metadata.readOnly
      : !permissions.includes("edit") && !permissions.includes("configure");
  const providerLocked = typeof metadata.provider_locked === "boolean"
    ? metadata.provider_locked
    : typeof metadata.providerLocked === "boolean"
      ? metadata.providerLocked
      : false;

  return {
    capability_id:
      stringOrUndefined(metadata.capability_id) ??
      stringOrUndefined(metadata.capabilityId) ??
      requestedCapabilityId,
    capability_permissions: permissions,
    read_only: readOnly,
    provider_locked: providerLocked,
    provider_id: providerId,
    provider_manifest_version:
      stringOrUndefined(metadata.provider_manifest_version) ??
      stringOrUndefined(metadata.providerManifestVersion) ??
      stringOrUndefined(metadata.manifest_version) ??
      stringOrUndefined(metadata.manifestVersion),
    provider_manifest_digest:
      stringOrUndefined(metadata.provider_manifest_digest) ??
      stringOrUndefined(metadata.providerManifestDigest) ??
      stringOrUndefined(metadata.manifest_digest) ??
      stringOrUndefined(metadata.manifestDigest),
    provider_manifest_signature_key_id:
      stringOrUndefined(metadata.provider_manifest_signature_key_id) ??
      stringOrUndefined(metadata.providerManifestSignatureKeyId) ??
      stringOrUndefined(metadata.signature_key_id) ??
      stringOrUndefined(metadata.signatureKeyId),
    provider_manifest_signed: typeof metadata.provider_manifest_signed === "boolean"
      ? metadata.provider_manifest_signed
      : typeof metadata.providerManifestSigned === "boolean"
        ? metadata.providerManifestSigned
        : undefined,
    source_type: sourceType,
    source_ref: sourceRef,
    source,
  };
}
