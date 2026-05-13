export const CAPABILITY_ROLE_OPTIONS = [
  {
    value: "ARCHITECT",
    label: "Architect",
    description: "Owns architecture, boundaries, dependencies, risks, and tradeoffs.",
  },
  {
    value: "DEVELOPER",
    label: "Developer",
    description: "Turns approved plans into implementation tasks and code-change evidence.",
  },
  {
    value: "QA",
    label: "QA",
    description: "Owns regression, verification, acceptance criteria, and test evidence.",
  },
  {
    value: "SECURITY",
    label: "Security",
    description: "Reviews auth, secrets, data exposure, and unsafe tool use.",
  },
  {
    value: "DEVOPS",
    label: "DevOps",
    description: "Owns build, deploy, runtime, observability, and rollback concerns.",
  },
  {
    value: "PRODUCT_OWNER",
    label: "Product Owner",
    description: "Keeps goals, acceptance criteria, user impact, and priority clear.",
  },
  {
    value: "BUSINESS_ANALYST",
    label: "Business Analyst",
    description: "Clarifies business rules, process impact, and domain vocabulary.",
  },
  {
    value: "GOVERNANCE",
    label: "Governance",
    description: "Reviews policy, audit, approval, and compliance constraints.",
  },
] as const;

export type CapabilityRoleValue = (typeof CAPABILITY_ROLE_OPTIONS)[number]["value"];

export function capabilityRoleLabel(value: unknown): string {
  const role = CAPABILITY_ROLE_OPTIONS.find((item) => item.value === value);
  return role?.label ?? String(value ?? "Agent").replaceAll("_", " ");
}
