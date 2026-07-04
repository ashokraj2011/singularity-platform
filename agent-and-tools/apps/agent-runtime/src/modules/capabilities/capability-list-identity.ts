import {
  capabilityNaturalKey,
  normalizedIdentityValue,
  type CapabilityIdentityInput,
} from "./capability-identity";

export type CapabilityListIdentityRow = CapabilityIdentityInput & {
  id: string;
  status: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type CapabilityListCanonicalRow<T> = T & {
  duplicateCapabilityIds?: string[];
  duplicateCapabilityCount?: number;
};

export function collapseCapabilityListDuplicates<T extends CapabilityListIdentityRow>(
  rows: T[],
): Array<CapabilityListCanonicalRow<T>> {
  const grouped = new Map<string, T[]>();
  const passthrough: T[] = [];
  for (const row of rows) {
    const key = capabilityListIdentityBucket(row);
    if (!key) {
      passthrough.push(row);
      continue;
    }
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  const collapsed: Array<CapabilityListCanonicalRow<T>> = [...passthrough];
  for (const group of grouped.values()) {
    const ordered = group.slice().sort(compareCapabilityListCanonical);
    const canonical = ordered[0];
    const duplicates = ordered.slice(1);
    collapsed.push(duplicates.length > 0
      ? {
          ...canonical,
          duplicateCapabilityIds: duplicates.map(row => row.id),
          duplicateCapabilityCount: duplicates.length,
        }
      : canonical);
  }
  return collapsed.sort(compareCapabilityListDisplay);
}

export function capabilityListIdentityBucket(row: CapabilityIdentityInput & { status: unknown }): string | null {
  const status = normalizedIdentityValue(String(row.status ?? "")).toUpperCase();
  if (!status || status === "DRAFT" || status === "INACTIVE") return null;
  const key = capabilityNaturalKey(row);
  return key.includes("::") || key.endsWith(":") ? null : `${status}:${key}`;
}

export function compareCapabilityListCanonical<T extends { id: string; createdAt: Date; updatedAt: Date }>(
  a: T,
  b: T,
): number {
  const created = a.createdAt.getTime() - b.createdAt.getTime();
  if (created !== 0) return created;
  const updated = a.updatedAt.getTime() - b.updatedAt.getTime();
  if (updated !== 0) return updated;
  return a.id.localeCompare(b.id);
}

export function compareCapabilityListDisplay<T extends { id: string; status: unknown; createdAt: Date }>(
  a: T,
  b: T,
): number {
  const status = capabilityListStatusRank(a.status) - capabilityListStatusRank(b.status);
  if (status !== 0) return status;
  const created = b.createdAt.getTime() - a.createdAt.getTime();
  if (created !== 0) return created;
  return b.id.localeCompare(a.id);
}

export function capabilityListStatusRank(status: unknown): number {
  const normalized = normalizedIdentityValue(String(status ?? "")).toUpperCase();
  if (normalized === "ACTIVE") return 0;
  if (normalized === "DRAFT") return 1;
  if (normalized === "INACTIVE") return 2;
  if (normalized === "ARCHIVED") return 3;
  return 2;
}
