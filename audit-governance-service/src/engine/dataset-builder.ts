/**
 * Singularity Engine — dataset builder.
 *
 * Builds eval datasets from production traces linked to engine issues.
 * Each dataset contains input/output/expected pairs that can be used
 * for offline evaluation.
 */
import { query, queryOne } from "../db";

// ── Types ──────────────────────────────────────────────────────────────

export interface DatasetCreateRequest {
  name:          string;
  description?:  string;
  issue_id?:     string;
  capability_id?: string;
}

export interface DatasetExampleInput {
  trace_id:        string;
  input:           Record<string, unknown>;
  expected_output?: Record<string, unknown>;
  actual_output?:  Record<string, unknown>;
  criteria?:       Record<string, unknown>;
  metadata?:       Record<string, unknown>;
}

// ── Dataset CRUD ───────────────────────────────────────────────────────

export async function createDataset(req: DatasetCreateRequest): Promise<{ id: string; name: string }> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO audit_governance.engine_datasets
       (name, description, issue_id, capability_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [req.name, req.description ?? null, req.issue_id ?? null, req.capability_id ?? null],
  );
  return { id: row!.id, name: req.name };
}

export async function addExamples(
  datasetId: string,
  examples: DatasetExampleInput[],
): Promise<{ added: number }> {
  let added = 0;
  for (const ex of examples) {
    await query(
      `INSERT INTO audit_governance.engine_dataset_examples
         (dataset_id, trace_id, input, expected_output, actual_output, criteria, metadata)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb)`,
      [
        datasetId,
        ex.trace_id,
        JSON.stringify(ex.input),
        ex.expected_output ? JSON.stringify(ex.expected_output) : null,
        ex.actual_output ? JSON.stringify(ex.actual_output) : null,
        ex.criteria ? JSON.stringify(ex.criteria) : null,
        JSON.stringify(ex.metadata ?? {}),
      ],
    );
    added++;
  }

  // Update example_count on the dataset.
  await query(
    `UPDATE audit_governance.engine_datasets
     SET example_count = (
       SELECT COUNT(*) FROM audit_governance.engine_dataset_examples WHERE dataset_id = $1
     ), updated_at = now()
     WHERE id = $1`,
    [datasetId],
  );

  return { added };
}

// ── Auto-build dataset from an engine issue ──────────────────────────

/**
 * Pull failing traces from an engine issue and build a dataset of
 * input/output pairs. The "input" is extracted from user messages in
 * the trace; the "actual_output" from assistant messages.
 */
export async function buildDatasetFromIssue(issueId: string): Promise<{
  dataset_id: string;
  examples_added: number;
}> {
  const issue = await queryOne<Record<string, unknown>>(
    `SELECT id, title, category, sample_trace_ids, capability_id
     FROM audit_governance.engine_issues WHERE id = $1`,
    [issueId],
  );
  if (!issue) throw Object.assign(new Error("issue not found"), { status: 404 });

  const traceIds = (issue.sample_trace_ids as string[]) ?? [];
  if (traceIds.length === 0) {
    throw Object.assign(new Error("issue has no sample traces"), { status: 400 });
  }

  // Create the dataset.
  const ds = await createDataset({
    name: `eval-${String(issue.category ?? "unknown")}-${String(issue.id).slice(0, 8)}`,
    description: `Auto-generated from issue: ${String(issue.title).slice(0, 200)}`,
    issue_id: issueId,
    capability_id: issue.capability_id as string | undefined,
  });

  // For each trace, extract the user input and agent output from the audit events.
  const examples: DatasetExampleInput[] = [];

  for (const tid of traceIds.slice(0, 20)) {
    const events = await query<Record<string, unknown>>(
      `SELECT kind, payload, created_at
       FROM audit_governance.audit_events
       WHERE trace_id = $1
       ORDER BY created_at ASC`,
      [tid],
    );

    // Extract: first user message as input, last assistant response as actual output,
    // any tool errors as failure context.
    let userInput: Record<string, unknown> | null = null;
    let agentOutput: Record<string, unknown> | null = null;
    const errors: string[] = [];

    for (const evt of events) {
      const payload = evt.payload as Record<string, unknown>;
      const kind = String(evt.kind);

      // Capture the invoke payload (contains the user prompt).
      if (kind === "mcp.invoke.started" || kind === "mcp.run.started") {
        userInput = { prompt: payload.prompt ?? payload.message ?? payload };
      }

      // Capture tool failures.
      if (kind === "tool.invocation.completed" && payload.success === false) {
        errors.push(String(payload.error ?? "tool error"));
      }

      // Capture the final response.
      if (kind === "mcp.invoke.completed" || kind === "mcp.run.completed") {
        agentOutput = { response: payload.response ?? payload };
      }
    }

    if (userInput) {
      examples.push({
        trace_id: tid,
        input: userInput,
        actual_output: agentOutput ?? undefined,
        criteria: errors.length > 0
          ? { should_not_contain_errors: errors, pass_condition: "no tool failures" }
          : { pass_condition: "successful completion" },
        metadata: {
          issue_id: issueId,
          event_count: events.length,
          error_count: errors.length,
        },
      });
    }
  }

  const { added } = await addExamples(ds.id, examples);

  return { dataset_id: ds.id, examples_added: added };
}
