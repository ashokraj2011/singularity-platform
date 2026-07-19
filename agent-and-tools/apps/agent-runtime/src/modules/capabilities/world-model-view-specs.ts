/**
 * Per-view content specifications — PURE data, no I/O.
 *
 * Each spec says what one view must contain, who reads it, how long it may be,
 * and which grounding inputs it needs. The builder turns a spec into an LLM
 * system prompt; nothing else encodes view content, so changing what (say) the
 * testing view covers is a one-object edit here.
 *
 * Two rules shape every spec:
 *  - Views are written for ONE audience. The business view does not explain
 *    class layout; the development view does not restate business impact. That
 *    separation is the whole point of loading narrowly.
 *  - Word caps are real. A view that must be trimmed at inject time wasted the
 *    tokens it took to build, so the cap is stated to the model up front.
 */

import type { WorldModelViewKind } from "./world-model-views.types";

/** Which grounding inputs a view needs. Keeps repo-less capabilities honest. */
export type GroundingSelector =
  | "capability" // name, description, type, criticality, parent/children
  | "worldModel" // language, build system, commands, readme summary
  | "architectureSlice" // root packages + public symbols
  | "codeSymbols" // file/symbol/line rows — the source of evidence locations
  | "agentRules" // CLAUDE.md / AGENTS.md / .cursor/rules verbatim
  | "knowledgeArtifacts" // uploaded/ingested docs
  | "childWorldModels"; // condensed child-capability grounding

export type ViewSpec = {
  kind: WorldModelViewKind;
  title: string;
  audience: string;
  /** Required section headings, in order. The model must use these verbatim. */
  sections: string[];
  grounding: GroundingSelector[];
  minWords: number;
  maxWords: number;
  /** Extra instruction unique to this view, appended to the universal rules. */
  emphasis?: string;
};

const CORE: ViewSpec = {
  kind: "core_summary",
  title: "Capability Core",
  audience: "every agent, as shared orientation before its role view",
  sections: [
    "What this capability is",
    "Main components",
    "Entry points",
    "Technologies and build system",
    "Standard commands",
    "Risks",
    "Unknowns",
  ],
  grounding: ["capability", "worldModel", "architectureSlice", "childWorldModels"],
  minWords: 500,
  maxWords: 1000,
  emphasis:
    "This is the ONLY view every agent loads, so it must be orientation, not detail. Do not include business rules, test inventories, deployment steps, or implementation specifics — those belong to their own views.",
};

const BUSINESS: ViewSpec = {
  kind: "business",
  title: "Business View",
  audience: "product managers, business analysts, and business-facing agents",
  sections: [
    "Capability map",
    "Actors and users",
    "Business workflows",
    "Business entities and vocabulary",
    "Business rules and where they live",
    "User-visible failure behaviour",
    "Compliance and data sensitivity",
    "Business impact of change",
    "Unknown business assumptions",
    "Questions for domain owners",
  ],
  grounding: ["capability", "worldModel", "knowledgeArtifacts", "childWorldModels", "architectureSlice"],
  minWords: 1000,
  maxWords: 2000,
  emphasis:
    "Describe behaviour and impact, not implementation. Name a file only when a business rule is enforced there. Prefer the domain's own vocabulary over technical naming.",
};

const ARCHITECTURE: ViewSpec = {
  kind: "architecture",
  title: "Architecture View",
  audience: "solution architects, technical leads, and design agents",
  sections: [
    "System context",
    "Component map and responsibilities",
    "Dependencies",
    "Interfaces and contracts",
    "Data ownership",
    "Key runtime workflows",
    "Trust and security boundaries",
    "Scalability and reliability signals",
    "Architectural invariants",
    "Architectural debt and risks",
    "Decisions inferred from the repository",
    "Needs architectural confirmation",
  ],
  grounding: ["capability", "worldModel", "architectureSlice", "codeSymbols", "childWorldModels", "knowledgeArtifacts"],
  minWords: 1500,
  maxWords: 3000,
  emphasis:
    "Record meaningful architectural relationships only — not every import. An invariant is worth more than a diagram: state what must remain true and what breaks if it does not.",
};

const DEVELOPMENT: ViewSpec = {
  kind: "development",
  title: "Development View",
  audience: "developers and debugging, refactoring, and code-review agents",
  sections: [
    "Where to start",
    "Source tree map",
    "Important modules and symbols",
    "Entry points and initialisation",
    "Common implementation flows",
    "Error-handling conventions",
    "Logging and observability conventions",
    "Configuration loading",
    "Persistence access patterns",
    "Coding and naming conventions",
    "Generated-code boundaries",
    "Change-impact guide",
    "Debugging starting points",
    "Validation commands",
    "Implementation hotspots",
  ],
  grounding: ["capability", "worldModel", "architectureSlice", "codeSymbols", "agentRules"],
  minWords: 1500,
  maxWords: 3000,
  emphasis:
    "Prefer concrete paths and symbols over prose. Every convention must cite where it is practised. The change-impact guide is the highest-value section: for each common kind of change, say which files move together.",
};

const TESTING: ViewSpec = {
  kind: "testing",
  title: "Testing View",
  audience: "QA engineers and test-authoring, validation, and review agents",
  sections: [
    "Test strategy in this repository",
    "Test layers and where they live",
    "Test commands",
    "Test environment requirements",
    "Fixtures, factories, and mocks",
    "Component-to-test map",
    "Critical positive scenarios",
    "Critical negative and failure scenarios",
    "Boundary and edge cases",
    "Concurrency, retry, and idempotency coverage",
    "Coverage gaps",
    "Risk-based regression suite",
    "Test selection by changed path",
  ],
  grounding: ["capability", "worldModel", "codeSymbols", "architectureSlice", "agentRules"],
  minWords: 1000,
  maxWords: 2500,
  emphasis:
    "Distinguish tests DISCOVERED from tests EXECUTED — you are reading a repository, not running it, so never claim a test passes. Coverage gaps and the test-selection map are what an agent actually needs.",
};

const RELEASE: ViewSpec = {
  kind: "release",
  title: "Release View",
  audience: "release managers, DevOps engineers, and deployment agents",
  sections: [
    "Build process",
    "Artifacts produced",
    "Versioning strategy",
    "Branching and tags",
    "CI workflow",
    "Deployment workflow",
    "Environments",
    "Configuration and secret names",
    "Database and data migrations",
    "Feature flags",
    "Pre-release checks",
    "Deployment ordering",
    "Post-deployment verification",
    "Rollback behaviour",
    "Manual steps and approvals",
    "Release risks",
  ],
  grounding: ["capability", "worldModel", "agentRules", "knowledgeArtifacts"],
  minWords: 1000,
  maxWords: 2500,
  emphasis:
    "Never assume a rollback exists — if it cannot be proven from the repository, say so under Unknowns. Name secrets by NAME only; never reproduce a secret value.",
};

const OPERATIONS: ViewSpec = {
  kind: "operations",
  title: "Operations View",
  audience: "SRE, incident response, and runtime-support agents",
  sections: [
    "Runtime topology",
    "Health checks",
    "Logs, metrics, and traces",
    "Alerts",
    "Queues and scheduled jobs",
    "Retry and timeout behaviour",
    "Failure modes",
    "External dependencies",
    "Runbooks and recovery",
    "Operational configuration",
    "Incident investigation starting points",
  ],
  grounding: ["capability", "worldModel", "architectureSlice", "knowledgeArtifacts", "childWorldModels"],
  minWords: 1000,
  maxWords: 2500,
  emphasis:
    "Write for someone paged at 3am: lead each failure mode with its symptom, then where to look. Say plainly when no alerting or runbook exists.",
};

const SECURITY: ViewSpec = {
  kind: "security",
  title: "Security View",
  audience: "security reviewers and security-focused agents",
  sections: [
    "Authentication",
    "Authorization",
    "Trust boundaries",
    "Secret names and loading",
    "Sensitive data",
    "Input validation",
    "Cryptographic usage",
    "Network exposure",
    "Privileged operations",
    "Audit logging",
    "Security tests",
    "Security assumptions and unknowns",
  ],
  grounding: ["capability", "worldModel", "architectureSlice", "codeSymbols", "agentRules"],
  minWords: 1000,
  maxWords: 2500,
  emphasis:
    "NEVER output a secret value — names and loading mechanisms only. Absence of evidence is not absence of a control: if you cannot see how authorization is enforced, record it as an unknown rather than asserting there is none.",
};

const DOMAIN: ViewSpec = {
  kind: "domain",
  title: "Domain Model",
  audience: "any agent working inside one business or technical capability area",
  sections: [
    "Domain purpose",
    "Terminology",
    "Business rules",
    "Owning components and symbols",
    "Entry points",
    "Main workflows",
    "Data and state",
    "External integrations",
    "Invariants",
    "Tests",
    "Change risks",
    "Unknowns",
  ],
  grounding: ["capability", "worldModel", "architectureSlice", "codeSymbols", "knowledgeArtifacts"],
  minWords: 750,
  maxWords: 2000,
  emphasis:
    "Scope strictly to the named domain. A domain is a meaningful capability area, not a directory — exclude anything a change in this domain would not touch.",
};

const TASK_GUIDE: ViewSpec = {
  kind: "task_guide",
  title: "Task Guide",
  audience: "the agent executing one specific, named task",
  sections: [
    "Task interpretation",
    "Relevant components and domains",
    "Primary paths and symbols",
    "Expected change flow",
    "Contracts and invariants to preserve",
    "Tests to add or update",
    "Commands to run",
    "Release or migration implications",
    "Risks",
    "Unknowns needing human confirmation",
  ],
  grounding: ["capability", "worldModel", "architectureSlice", "codeSymbols", "agentRules"],
  minWords: 500,
  maxWords: 1500,
  emphasis:
    "This is the smallest sufficient grounding package for ONE task. Ruthlessly exclude anything the task does not touch — a task guide that restates the development view has failed.",
};

const SPECS: Record<WorldModelViewKind, ViewSpec> = {
  core_summary: CORE,
  business: BUSINESS,
  architecture: ARCHITECTURE,
  development: DEVELOPMENT,
  testing: TESTING,
  release: RELEASE,
  operations: OPERATIONS,
  security: SECURITY,
  domain: DOMAIN,
  task_guide: TASK_GUIDE,
};

export function viewSpec(kind: WorldModelViewKind): ViewSpec {
  return SPECS[kind];
}

export function allViewSpecs(): ViewSpec[] {
  return Object.values(SPECS);
}

/** The default "auto" build set: the shared core plus the seven role views. */
export function defaultBuildKinds(): WorldModelViewKind[] {
  return ["core_summary", "business", "architecture", "development", "testing", "release", "operations", "security"];
}

/**
 * Grounding a capability cannot supply is dropped rather than faked. A capability
 * with no repository has no code symbols or architecture slice, so its views are
 * built from description, knowledge artifacts and child capabilities — and their
 * evidence points at artifacts instead of file lines.
 */
export function selectorsFor(spec: ViewSpec, opts: { repoBacked: boolean }): GroundingSelector[] {
  if (opts.repoBacked) return spec.grounding;
  const repoOnly: GroundingSelector[] = ["architectureSlice", "codeSymbols", "agentRules"];
  return spec.grounding.filter((s) => !repoOnly.includes(s));
}
