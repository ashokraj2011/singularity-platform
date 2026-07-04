export type CapabilityRow = Record<string, unknown>;

export type CapabilityDuplicateGroup = {
  key: string;
  canonical: CapabilityRow;
  duplicateIds: string[];
  duplicateCount: number;
};

export function capabilityRowsFromListResponse(value: unknown): CapabilityRow[] {
  const rows = Array.isArray(value)
    ? value
    : firstArrayField(value, "items", "capabilities", "data", "rows");
  return rows.filter(isRecord);
}

export function isArchivedCapability(capability: CapabilityRow): boolean {
  return String(capability.status ?? "").toUpperCase() === "ARCHIVED";
}

export function capabilityRowId(capability: CapabilityRow): string {
  return capabilityString(capability, "id", "capabilityId", "capability_id");
}

export function capabilityText(capability: CapabilityRow, ...keys: string[]): string {
  return capabilityString(capability, ...keys);
}

export function capabilityDisplayName(capability: CapabilityRow): string {
  return capabilityString(capability, "name", "capabilityName", "capability_name")
    || capabilityRowId(capability)
    || "Untitled capability";
}

export function capabilityIdentityKey(capability: CapabilityRow): string {
  const appId = capabilityString(capability, "appId", "app_id", "applicationId", "application_id").toLowerCase();
  if (appId) return `capability:app:${appId}`;
  const name = capabilityString(capability, "name", "capabilityName", "capability_name").toLowerCase();
  if (!name) return "";
  const type = capabilityString(capability, "capabilityType", "capability_type").toLowerCase() || "default";
  return `capability:name:${type}:${name}`;
}

export function uniqueCapabilitiesByIdentity(capabilities: CapabilityRow[]): CapabilityRow[] {
  const canonicalByKey = canonicalCapabilitiesByIdentity(capabilities);
  const seenIdentityKeys = new Set<string>();
  const seenFallbackKeys = new Set<string>();
  return capabilities.filter(capability => {
    const identityKey = capabilityCanCollapseByIdentity(capability) ? capabilityIdentityKey(capability) : "";
    const key = identityKey || String(capability.id ?? "");
    if (!key) return false;
    if (!identityKey) {
      if (seenFallbackKeys.has(key)) return false;
      seenFallbackKeys.add(key);
      return true;
    }
    if (seenIdentityKeys.has(key)) return false;
    if (canonicalByKey.get(key) !== capability) return false;
    seenIdentityKeys.add(key);
    return true;
  });
}

export function duplicateCapabilitiesByIdentity(capabilities: CapabilityRow[]): CapabilityDuplicateGroup[] {
  const groups = new Map<string, CapabilityRow[]>();
  for (const capability of capabilities) {
    if (!capabilityCanCollapseByIdentity(capability)) continue;
    const key = capabilityIdentityKey(capability);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), capability]);
  }
  const merged = new Map<string, CapabilityDuplicateGroup>();
  const rawGroups = Array.from(groups.entries())
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => {
      const ordered = group.slice().sort(compareCanonicalCapabilities);
      return duplicateGroupFromCanonical(key, ordered[0], ordered.slice(1));
    });
  for (const group of [...rawGroups, ...serverCollapsedDuplicateGroups(capabilities)]) {
    const existing = merged.get(group.key);
    merged.set(group.key, existing ? mergeDuplicateGroups(existing, group) : group);
  }
  return Array.from(merged.values()).filter(group => group.duplicateCount > 0);
}

export function capabilityIdentityLabel(capability: CapabilityRow): string {
  const appId = capabilityString(capability, "appId", "app_id", "applicationId", "application_id");
  if (appId) return `app: ${appId}`;
  const name = capabilityString(capability, "name", "capabilityName", "capability_name") || "Unnamed capability";
  const type = capabilityString(capability, "capabilityType", "capability_type") || "default";
  return `${name} (${type})`;
}

export function capabilityShortId(capability: CapabilityRow | string | number): string {
  const id = String(
    typeof capability === "string" || typeof capability === "number" ? capability : capability.id ?? "",
  ).trim();
  return id ? id.slice(0, 8) : "unknown";
}

function serverCollapsedDuplicateGroups(capabilities: CapabilityRow[]): CapabilityDuplicateGroup[] {
  const groups = new Map<string, CapabilityDuplicateGroup>();
  for (const capability of capabilities) {
    if (!capabilityCanCollapseByIdentity(capability)) continue;
    const key = capabilityIdentityKey(capability);
    if (!key) continue;
    const serverDuplicateIds = capabilityStringArray(
      capability,
      "duplicateCapabilityIds",
      "duplicate_capability_ids",
    );
    const serverDuplicateCount = capabilityNumber(
      capability,
      "duplicateCapabilityCount",
      "duplicate_capability_count",
    );
    if (serverDuplicateIds.length === 0 && serverDuplicateCount === 0) continue;
    const existing = groups.get(key);
    const group = duplicateGroupFromCanonical(key, capability, [], serverDuplicateIds, serverDuplicateCount);
    if (!existing || compareCanonicalCapabilities(group.canonical, existing.canonical) < 0) {
      groups.set(key, group);
    }
  }
  return Array.from(groups.values());
}

function duplicateGroupFromCanonical(
  key: string,
  canonical: CapabilityRow,
  duplicates: CapabilityRow[],
  serverDuplicateIds: string[] = capabilityStringArray(canonical, "duplicateCapabilityIds", "duplicate_capability_ids"),
  serverDuplicateCount = capabilityNumber(canonical, "duplicateCapabilityCount", "duplicate_capability_count"),
): CapabilityDuplicateGroup {
  const ids = new Set<string>();
  for (const duplicate of duplicates) {
    const id = String(duplicate.id ?? "").trim();
    if (id) ids.add(id);
  }
  for (const id of serverDuplicateIds) ids.add(id);
  return {
    key,
    canonical,
    duplicateIds: Array.from(ids),
    duplicateCount: Math.max(ids.size, duplicates.length, serverDuplicateCount),
  };
}

function mergeDuplicateGroups(a: CapabilityDuplicateGroup, b: CapabilityDuplicateGroup): CapabilityDuplicateGroup {
  const canonical = compareCanonicalCapabilities(a.canonical, b.canonical) <= 0 ? a.canonical : b.canonical;
  const ids = new Set([...a.duplicateIds, ...b.duplicateIds]);
  const canonicalId = String(canonical.id ?? "").trim();
  if (canonicalId) ids.delete(canonicalId);
  return {
    key: a.key,
    canonical,
    duplicateIds: Array.from(ids),
    duplicateCount: Math.max(ids.size, a.duplicateCount, b.duplicateCount),
  };
}

function canonicalCapabilitiesByIdentity(capabilities: CapabilityRow[]): Map<string, CapabilityRow> {
  const groups = new Map<string, CapabilityRow[]>();
  for (const capability of capabilities) {
    if (!capabilityCanCollapseByIdentity(capability)) continue;
    const key = capabilityIdentityKey(capability);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(capability);
    groups.set(key, group);
  }
  const canonicalByKey = new Map<string, CapabilityRow>();
  for (const [key, group] of groups.entries()) {
    canonicalByKey.set(key, group.slice().sort(compareCanonicalCapabilities)[0]);
  }
  return canonicalByKey;
}

function compareCanonicalCapabilities(a: CapabilityRow, b: CapabilityRow): number {
  const aCreated = capabilityTimestamp(a, "createdAt", "created_at");
  const bCreated = capabilityTimestamp(b, "createdAt", "created_at");
  if (aCreated !== bCreated) return aCreated - bCreated;
  const aUpdated = capabilityTimestamp(a, "updatedAt", "updated_at");
  const bUpdated = capabilityTimestamp(b, "updatedAt", "updated_at");
  if (aUpdated !== bUpdated) return aUpdated - bUpdated;
  return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

function firstArrayField(value: unknown, ...keys: string[]): unknown[] {
  if (!isRecord(value)) return [];
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function isRecord(value: unknown): value is CapabilityRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function capabilityString(capability: CapabilityRow, ...keys: string[]): string {
  for (const key of keys) {
    const value = capability[key];
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return "";
}

function capabilityStringArray(capability: CapabilityRow, ...keys: string[]): string[] {
  const seen = new Set<string>();
  for (const key of keys) {
    const value = capability[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item !== "string" && typeof item !== "number") continue;
      const text = String(item).trim();
      if (text) seen.add(text);
    }
  }
  return Array.from(seen);
}

function capabilityNumber(capability: CapabilityRow, ...keys: string[]): number {
  for (const key of keys) {
    const value = capability[key];
    const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  }
  return 0;
}

function capabilityTimestamp(capability: CapabilityRow, ...keys: string[]): number {
  for (const key of keys) {
    const value = capability[key];
    if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) continue;
    const timestamp = new Date(value).getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Number.POSITIVE_INFINITY;
}

function capabilityCanCollapseByIdentity(capability: CapabilityRow): boolean {
  const status = capabilityString(capability, "status").toUpperCase();
  return Boolean(status && status !== "DRAFT" && status !== "INACTIVE");
}
