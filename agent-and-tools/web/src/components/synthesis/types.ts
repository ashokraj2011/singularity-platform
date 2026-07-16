/**
 * Shared types for the Synthesis app. These mirror the workgraph API response
 * shapes (studio projects, discovery, rooms) so screens can be strongly typed.
 */

export type ProjectStatus = "ACTIVE" | "ARCHIVED" | "DRAFT" | string;

export interface SynProject {
  id: string;
  code: string;
  name: string;
  mission?: string | null;
  status: ProjectStatus;
  createdById?: string | null;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  workItemCount: number;
}

export interface SynWorkItemCard {
  id: string;
  code?: string;
  title?: string;
  name?: string;
  status?: string;
  projectId?: string | null;
  updatedAt?: string;
  createdAt?: string;
}

export interface SynPortfolio {
  projects: SynProject[];
  standaloneWorkItems: SynWorkItemCard[];
}

/* ─── Discovery ─────────────────────────────────────────────────────────── */

export type DiscoveryQuestionStatus = "OPEN" | "ANSWERED" | "DISMISSED" | string;
export type DiscoveryAssumptionStatus =
  | "PROPOSED"
  | "VALIDATED"
  | "REJECTED"
  | "PENDING"
  | string;

export interface DiscoveryQuestion {
  id: string;
  sessionId: string;
  prompt: string;
  rationale?: string | null;
  status: DiscoveryQuestionStatus;
  blocking?: boolean;
  answer?: string | null;
  category?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface DiscoveryAssumption {
  id: string;
  sessionId: string;
  statement: string;
  rationale?: string | null;
  status: DiscoveryAssumptionStatus;
  confidence?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface DiscoverySession {
  id: string;
  scopeType?: string;
  scopeId?: string | null;
  status?: string;
  questions?: DiscoveryQuestion[];
  assumptions?: DiscoveryAssumption[];
  blocked?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/* ─── Rooms / claims ────────────────────────────────────────────────────── */

export interface SynRoom {
  id: string;
  title: string;
  projectId: string;
  status?: string;
  createdAt?: string;
}

export interface SynClaim {
  id: string;
  roomId?: string | null;
  projectId: string;
  statement: string;
  status?: string;
  confidence?: number | null;
  contested?: boolean;
  createdAt?: string;
}
