import { prisma } from "../../config/prisma";
import { ForbiddenError, NotFoundError } from "../../shared/errors";

export const ARCHIVED_CAPABILITY_STATUS = "ARCHIVED";
export const DEFAULT_ARCHIVED_CAPABILITY_MESSAGE = "Capability is archived and cannot be modified.";

type CapabilityStatusLike = {
  status?: string | null;
};

export function isArchivedCapability(capability: CapabilityStatusLike | null | undefined): boolean {
  return capability?.status === ARCHIVED_CAPABILITY_STATUS;
}

export function assertCapabilityNotArchived(
  capability: CapabilityStatusLike,
  message = DEFAULT_ARCHIVED_CAPABILITY_MESSAGE,
): void {
  if (isArchivedCapability(capability)) {
    throw new ForbiddenError(message);
  }
}

export async function requireActiveCapability(
  capabilityId: string,
  message = DEFAULT_ARCHIVED_CAPABILITY_MESSAGE,
): Promise<{ id: string; status: string }> {
  const capability = await prisma.capability.findUnique({
    where: { id: capabilityId },
    select: { id: true, status: true },
  });
  if (!capability) throw new NotFoundError("Capability not found");
  assertCapabilityNotArchived(capability, message);
  return capability;
}

export async function capabilityIsArchivedOrMissing(capabilityId: string): Promise<boolean> {
  const capability = await prisma.capability.findUnique({
    where: { id: capabilityId },
    select: { status: true },
  });
  return !capability || isArchivedCapability(capability);
}
