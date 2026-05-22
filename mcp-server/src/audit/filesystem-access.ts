/**
 * M63 Slice C — Filesystem-access audit emission.
 *
 * Every filesystem tool (read_file, find_files, file_stats, grep_lines,
 * list_indexed_files) wraps its execution with `emitFilesystemAccess`
 * AFTER returning. Fire-and-forget — never blocks the tool, never
 * propagates failure.
 *
 * Two event kinds:
 *   tool.filesystem.access            — routine read. risk_level=low,
 *                                       severity=info. High volume;
 *                                       Splunk-like UI defaults to
 *                                       hiding this until an operator
 *                                       opts in via the "Directory
 *                                       access" quick filter.
 *   tool.filesystem.access.sensitive  — path matches a sensitive
 *                                       pattern (.env, *secret*,
 *                                       *key*, .ssh/*, ~/.aws/*).
 *                                       risk_level=high, severity=warn.
 *                                       Always visible at default filter.
 *
 * The split into two kinds (instead of one kind with a payload
 * flag) lets the search UI's allowlist + the SSE filter use the
 * lighter exact-match path instead of a JSONB extract in the WHERE.
 */
import { emitAuditEvent } from "../lib/audit-gov-emit";
import { log } from "../shared/log";

// Patterns matched against the FULL path (case-insensitive). Keep the
// list narrow — false positives noise up the high-risk feed.
//
// If you add a pattern, also document it in the M63 Slice C commit and
// in the Splunk-like UI's "Directory access" quick-filter tooltip so
// operators know what triggers the sensitive classification.
const SENSITIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)\.env(\.|$)/i,                 // .env, .env.local, .env.production
  /(^|\/)secret(s)?(\/|$|[._-])/i,      // secrets/, secret_xyz, my-secrets.json
  /(^|\/)\.ssh(\/|$)/i,                 // .ssh/anything
  /(^|\/)\.aws(\/|$)/i,                 // .aws/credentials
  /\.(pem|key|p12|pfx|crt)$/i,          // bare key/cert files
  /(^|\/)id_(rsa|ed25519|ecdsa)/i,      // ssh private keys by name
  /(^|\/)credentials(\.|$)/i,           // credentials.json, credentials.yaml
  /(^|\/)private[._-]/i,                // private_key.pem etc.
];

export function isSensitivePath(p: string): boolean {
  if (!p) return false;
  for (const re of SENSITIVE_PATTERNS) {
    if (re.test(p)) return true;
  }
  return false;
}

export type FilesystemAccessInput = {
  trace_id: string | undefined;
  capability_id?: string;
  actor_id?: string;
  tool: string;                      // "read_file" | "find_files" | "file_stats" | "grep_lines" | "list_indexed_files"
  path?: string;                     // single-path tools (read_file, file_stats)
  pattern?: string;                  // glob/regex tools (find_files, grep_lines, list_indexed_files)
  match_count?: number;              // result count (grep_lines, find_files)
  bytes?: number;                    // bytes returned (read_file)
  success: boolean;
  error?: string;
};

/**
 * Fire-and-forget audit emission for one filesystem-tool call.
 *
 * Sensitive-path detection runs on the SINGLE-PATH inputs (path).
 * For glob/regex tools, sensitivity is a property of the RESULTS, not
 * the pattern — those are routine reads from this helper's POV. (A
 * follow-up could add post-result scanning if we want to flag
 * `find_files` over a `*` *`/.env` pattern etc., but most agents
 * don't construct those patterns and we don't want to grep every
 * match list at audit time.)
 */
export function emitFilesystemAccess(input: FilesystemAccessInput): void {
  try {
    const sensitive = isSensitivePath(input.path ?? "");
    const kind = sensitive
      ? "tool.filesystem.access.sensitive"
      : "tool.filesystem.access";
    const severity: "info" | "warn" | "error" = !input.success
      ? "error"
      : sensitive ? "warn" : "info";

    emitAuditEvent({
      trace_id: input.trace_id,
      source_service: "mcp-server",
      kind,
      subject_type: "FilesystemAccess",
      subject_id: input.path ?? input.pattern ?? input.tool,
      actor_id: input.actor_id,
      capability_id: input.capability_id,
      severity,
      payload: {
        tool: input.tool,
        path: input.path,
        pattern: input.pattern,
        match_count: input.match_count,
        bytes: input.bytes,
        success: input.success,
        error: input.error,
        sensitive,
      },
    });
  } catch (err) {
    // Never let audit emission failures break a tool call. The audit
    // helper is already best-effort but the sensitive-path matcher
    // could theoretically throw on pathological regex input.
    log.warn({ err: (err as Error).message }, "filesystem-access audit emit failed");
  }
}
