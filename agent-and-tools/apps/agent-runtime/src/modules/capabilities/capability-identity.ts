import { Prisma } from "../../../generated/prisma-client";

export type CapabilityIdentityInput = {
  name?: string | null;
  appId?: string | null;
  capabilityType?: string | null;
};

export type CapabilityDuplicateSummary = {
  id: string;
  name: string;
  appId?: string | null;
  capabilityType?: string | null;
};

export function normalizedIdentityValue(value?: string | null): string {
  return String(value ?? "").trim();
}

export function normalizedCapabilityType(value?: string | null): string {
  return normalizedIdentityValue(value) || "default";
}

export function capabilityNaturalKey(input: CapabilityIdentityInput): string {
  const appId = normalizedIdentityValue(input.appId);
  if (appId) return `capability:app:${appId.toLowerCase()}`;
  return [
    "capability:name",
    normalizedCapabilityType(input.capabilityType).toLowerCase(),
    normalizedIdentityValue(input.name).toLowerCase(),
  ].join(":");
}

export function capabilityDuplicateWhere(
  input: CapabilityIdentityInput,
  excludeId?: string,
): Prisma.CapabilityWhereInput | null {
  const appId = normalizedIdentityValue(input.appId);
  const name = normalizedIdentityValue(input.name);
  const capabilityType = normalizedIdentityValue(input.capabilityType);
  const where: Prisma.CapabilityWhereInput = {
    status: "ACTIVE",
    ...(excludeId ? { id: { not: excludeId } } : {}),
  };

  if (appId) {
    where.appId = { equals: appId, mode: "insensitive" };
  } else if (name) {
    where.name = { equals: name, mode: "insensitive" };
    where.OR = capabilityType
      ? [{ capabilityType: { equals: capabilityType, mode: "insensitive" } }]
      : [
          { capabilityType: null },
          { capabilityType: "" },
          { capabilityType: { equals: "default", mode: "insensitive" } },
        ];
  } else {
    return null;
  }

  return where;
}

export function capabilityDuplicateConflictMessage(existing: CapabilityDuplicateSummary): string {
  const appText = existing.appId ? `appId ${existing.appId}` : `name ${existing.name}`;
  return `Active capability already exists for ${appText}. Open capability ${existing.id} instead of bootstrapping it again.`;
}
