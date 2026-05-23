/**
 * M74 Phase 2A — built-in rubric catalog for the LLM judge.
 *
 * Keyed by stage_type (developer / qa / architect / security / devops /
 * product_owner), with a fallback "generic" entry for anything else. The
 * defaults here are stage-typed not capability-typed (the latter is a
 * harder problem — rubrics drift across capabilities and need eval data
 * to tune; the former is good enough to start).
 *
 * Overriding: a caller can pass `evaluator_config.rubric_text` to
 * override any default. Useful when a specific capability needs a
 * custom rubric, or when an operator wants to A/B a rubric variant.
 *
 * Rubric text guidelines (from review feedback):
 *   • 1-5 scale with crisp anchors
 *   • Each criterion stands alone; the judge can mark them met/failed
 *   • Avoid criteria that need ground-truth knowledge the judge can't
 *     plausibly have ("does this match the customer's secret config?")
 *   • Skew permissive on judgment calls — the goal is to catch
 *     capability regressions, not optimise for the model's preferences
 */

export interface RubricSpec {
  /** The rubric body that goes into the judge's user prompt. */
  text: string;
  /** Where the rubric came from: "catalog" / "config" / "fallback-generic". */
  source: string;
  /** Stage type the rubric was selected for (null when from config or fallback). */
  stageType: string | null;
}

const DEVELOPER_RUBRIC = [
  "Does the diff plausibly implement the change the user/issue asked for?",
  "If tests are present in the repo, has the agent added or updated tests, or explicitly justified why none are needed?",
  "Is the diff minimal — no unrelated changes, no dead code, no commented-out blocks?",
  "Does the agent address every acceptance criterion mentioned in the issue, or explicitly note which ones it couldn't?",
  "Are there obvious red flags: hardcoded credentials, infinite loops, swallowed exceptions, removed safety checks?",
].join("\n  - ");

const QA_RUBRIC = [
  "Does the test plan cover every acceptance criterion in the issue, mapped 1:1?",
  "Are edge cases identified (empty/null/boundary inputs, concurrency, error paths)?",
  "Are the verification commands actually runnable against the repo (right tool, right path, right config)?",
  "Are tests deterministic — no time-of-day dependence, no flaky external calls without retries?",
  "Does the plan distinguish what was verified from what is asserted-not-verified?",
].join("\n  - ");

const ARCHITECT_RUBRIC = [
  "Does the design address every stated requirement, traced 1:1?",
  "Are the major risks enumerated, with mitigations or explicit accept-the-risk notes?",
  "Are at least 2 alternative approaches considered, with reasons for the chosen one?",
  "Are component boundaries + data flows clear enough that a developer could implement without re-deriving them?",
  "Are non-functional concerns (latency, cost, security, observability) called out where relevant?",
].join("\n  - ");

const SECURITY_RUBRIC = [
  "Does the review identify every concrete attack surface introduced by the diff?",
  "Are the OWASP / standard-control categories addressed (auth, authz, input validation, secrets, logging)?",
  "Are findings tied to specific lines or files, not generic platitudes?",
  "Are severity ratings justified, not just asserted?",
  "Are recommended fixes specific enough to implement without further security expertise?",
].join("\n  - ");

const DEVOPS_RUBRIC = [
  "Does the release plan enumerate every component that needs to deploy and in what order?",
  "Is the rollback plan specific (exact commands, exact failure signals to watch)?",
  "Are migration steps idempotent or guarded against re-run?",
  "Are dependencies on external services (DBs, queues, third-party APIs) called out with their health-check approach?",
  "Is there a clear go/no-go criterion for proceeding to the next deploy step?",
].join("\n  - ");

const PRODUCT_OWNER_RUBRIC = [
  "Does the story brief make the user-facing intent unambiguous (who, what, why)?",
  "Are acceptance criteria specific and testable (not 'works well' or 'is intuitive')?",
  "Are out-of-scope items explicitly named so the developer doesn't drift?",
  "Are dependencies on other stories or external decisions surfaced?",
  "Could a developer implement this without needing further clarification?",
].join("\n  - ");

const CATALOG: Record<string, RubricSpec> = {
  developer: {
    text: `Evaluate the developer agent's output against these criteria:\n  - ${DEVELOPER_RUBRIC}`,
    source: "catalog",
    stageType: "developer",
  },
  qa: {
    text: `Evaluate the QA agent's output against these criteria:\n  - ${QA_RUBRIC}`,
    source: "catalog",
    stageType: "qa",
  },
  architect: {
    text: `Evaluate the architect agent's output against these criteria:\n  - ${ARCHITECT_RUBRIC}`,
    source: "catalog",
    stageType: "architect",
  },
  security: {
    text: `Evaluate the security agent's output against these criteria:\n  - ${SECURITY_RUBRIC}`,
    source: "catalog",
    stageType: "security",
  },
  devops: {
    text: `Evaluate the DevOps agent's output against these criteria:\n  - ${DEVOPS_RUBRIC}`,
    source: "catalog",
    stageType: "devops",
  },
  product_owner: {
    text: `Evaluate the product-owner agent's output against these criteria:\n  - ${PRODUCT_OWNER_RUBRIC}`,
    source: "catalog",
    stageType: "product_owner",
  },
};

/**
 * Look up a rubric by stage type. Returns null when the type isn't in the
 * catalog so the caller can decide whether to fall back to the generic
 * rubric or to refuse the eval. Aliases for common spelling variants are
 * recognised (e.g. "dev" → "developer", "PRODUCT_OWNER" → "product_owner").
 */
export function getRubricForStageType(stageType: string): RubricSpec | null {
  const normalised = stageType.trim().toLowerCase().replace(/-/g, "_");
  const alias: Record<string, string> = {
    dev: "developer",
    engineer: "developer",
    quality: "qa",
    test: "qa",
    tester: "qa",
    arch: "architect",
    architecture: "architect",
    sec: "security",
    secops: "security",
    ops: "devops",
    sre: "devops",
    po: "product_owner",
    pm: "product_owner",
    product: "product_owner",
  };
  const key = alias[normalised] ?? normalised;
  return CATALOG[key] ?? null;
}

/** Exposed for tests + admin UI listing. */
export function listRubricStageTypes(): string[] {
  return Object.keys(CATALOG).sort();
}
