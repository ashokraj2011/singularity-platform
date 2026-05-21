/**
 * M52 — Code Context Budgeter (mcp-server side).
 *
 * Pure-function core that assembles a token-budgeted code-context package
 * from the existing AST primitives (findSymbols / getAstSlice /
 * getDependencies / listIndexedFiles). Invoked by Context Fabric BEFORE
 * Prompt Composer composes the system prompt — see
 * `POST /mcp/code-context/build` in app.ts.
 *
 * The result flows: this module → HTTP response → Context Fabric →
 * Prompt Composer (renders 7 CODE_* layers) → mcp-server /mcp/invoke →
 * LLM Gateway. Slice content is in-flight only; central audit tables
 * persist only content_hash + line ranges + token counts.
 *
 * Design choices:
 *   - Not registered as an agent-callable tool. The agent sees the
 *     resulting context as pre-rendered prompt layers — no inline call.
 *   - Tree-sitter AST queries run in-process via the existing
 *     ast-index.ts. No file content reaches anywhere outside mcp-server
 *     unless this function explicitly returns it.
 *   - Naive token estimator (1 token ≈ 4 chars) — matches the rest of
 *     the codebase (invoke.ts:3233 `estimateTextTokens`).
 *   - Test discovery via the same `expectedTestPathFor` heuristic
 *     review_diff already uses (workflow-tools.ts).
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import { v4 as uuidv4 } from "uuid";
import {
  findSymbols,
  getAstSlice,
  getDependencies,
  indexWorkspace,
  listIndexedFiles,
  type SymbolHit,
} from "../workspace/ast-index";
import { emitAuditEvent } from "../lib/audit-gov-emit";

// ─────────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────────

export interface BuildCodeContextRequest {
  /** User's goal text — what the developer agent is being asked to do. */
  task_text: string;
  /**
   * Optional caller-supplied symbol names. When omitted, derived from
   * `task_text` via the cheap keyword-to-symbol heuristic.
   */
  target_hints?: string[];
  /** Cap on combined slice tokens. Default 7000. */
  max_token_budget?: number;
  /** How deep to follow getDependencies(). Default 2. */
  max_dependency_depth?: number;
  /** Include heuristic test-file slices alongside code. Default true. */
  include_tests?: boolean;
  /** Trace id for audit linkage. Optional. */
  trace_id?: string;
  /** Capability id for audit linkage. Optional. */
  capability_id?: string;
}

export interface CodeContextSlice {
  file: string;
  symbol: string;
  language?: string;
  start_line: number;
  end_line: number;
  content: string;
  token_count: number;
  content_hash: string;
  /** Only set on dependency slices. */
  dependency_depth?: number;
}

export interface CodeContextPackage {
  context_package_id: string;
  task_intent: {
    kind: "code_modification" | "code_read" | "unknown";
    summary: string;
  };
  target_symbols: Array<{
    symbol: string;
    file: string;
    language: string;
    start_line: number;
    end_line: number;
    reason: string;
  }>;
  editable_slices: CodeContextSlice[];
  dependency_slices: CodeContextSlice[];
  test_slices: CodeContextSlice[];
  excluded_context: Array<{
    file: string;
    symbol?: string;
    reason: string;
    estimated_tokens_avoided?: number;
  }>;
  optimization: {
    raw_estimate: number;       // what a naive full-file approach would have cost
    optimized_estimate: number; // sum of included slice tokens
    tokens_saved: number;
    percent_saved: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_TOKEN_BUDGET = 7000;
const DEFAULT_DEPENDENCY_DEPTH = 2;
const DEFAULT_INCLUDE_TESTS = true;

/** Naive token estimator. Matches invoke.ts:3233. Inlined to avoid pulling
 *  a heavy import for one constant-cost helper. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** sha256 helper for content_hash. */
function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Stopwords to drop when deriving symbol queries from task_text. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "this", "that", "have", "must",
  "should", "implement", "add", "fix", "update", "make", "support", "create",
  "remove", "change", "ensure", "case", "not", "null", "true", "false",
  "string", "char", "value", "method", "function", "class", "test", "operator",
]);

/**
 * Derive candidate symbol-search queries from the user's task text.
 * Cheap heuristic: words ≥ 4 chars that aren't stopwords, deduped, capped at 6.
 * The findSymbols call is itself a fuzzy match so we're after rough hints,
 * not exact symbol names.
 */
export function deriveTargetQueries(taskText: string): string[] {
  const words = taskText
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Heuristic: given a code file, what's the conventional test path?
 * Mirrors `expectedTestPathFor` in workflow-tools.ts (M43 review_diff).
 * Kept in-module so this file is self-contained and changes to
 * workflow-tools don't accidentally break the budgeter.
 */
export function expectedTestPathFor(codePath: string): string[] {
  const base = path.basename(codePath);
  const dir = path.dirname(codePath);
  const ext = path.extname(base);
  const stem = base.slice(0, -ext.length);
  const candidates = new Set<string>();
  if (/\.(ts|tsx|js|jsx)$/i.test(ext)) {
    candidates.add(`${dir}/${stem}.test${ext}`);
    candidates.add(`${dir}/${stem}.spec${ext}`);
    candidates.add(`${dir}/__tests__/${stem}.test${ext}`);
  }
  if (ext === ".java") {
    const replaced = codePath.replace("/main/", "/test/");
    candidates.add(replaced.replace(`${stem}.java`, `${stem}Test.java`));
    candidates.add(replaced.replace(`${stem}.java`, `${stem}IT.java`));
  }
  if (ext === ".py") {
    candidates.add(`${dir}/test_${base}`);
    candidates.add(`tests/test_${base}`);
  }
  if (ext === ".go") {
    candidates.add(`${dir}/${stem}_test.go`);
  }
  return [...candidates];
}

// ─────────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a code-context package for the given task.
 *
 * Returns the structured package with slice content + token accounting.
 * Emits an audit event whose payload contains ONLY metadata (hashes, line
 * ranges, token counts) — slice content is NOT in the audit event.
 */
export async function buildCodeContextPackage(
  req: BuildCodeContextRequest,
): Promise<CodeContextPackage> {
  const budget = req.max_token_budget ?? DEFAULT_TOKEN_BUDGET;
  const depDepth = req.max_dependency_depth ?? DEFAULT_DEPENDENCY_DEPTH;
  const includeTests = req.include_tests ?? DEFAULT_INCLUDE_TESTS;
  const packageId = uuidv4();

  // 1. Ensure index is fresh. Re-indexing is idempotent + cached.
  await indexWorkspace("code_context_build");

  // 2. Resolve target symbols. Prefer caller-supplied hints; fall back to
  //    derived queries from task text.
  const queries = req.target_hints && req.target_hints.length > 0
    ? req.target_hints
    : deriveTargetQueries(req.task_text);

  const resolved: SymbolHit[] = [];
  const seenSymbolKey = new Set<string>();
  const excluded: CodeContextPackage["excluded_context"] = [];

  for (const q of queries) {
    const hits = await findSymbols({ query: q, limit: 3 });
    if (hits.length === 0) {
      excluded.push({
        file: "(unresolved)",
        symbol: q,
        reason: `symbol query "${q}" not found in index`,
      });
      continue;
    }
    for (const hit of hits.slice(0, 1)) {  // top hit per query is enough
      const key = `${hit.filePath}:${hit.startLine}`;
      if (seenSymbolKey.has(key)) continue;
      seenSymbolKey.add(key);
      resolved.push(hit);
    }
  }

  // 3. Fetch editable slices.
  const editableSlices: CodeContextSlice[] = [];
  for (const hit of resolved) {
    const slice = await getAstSlice({ symbolId: hit.id });
    if (!slice) {
      excluded.push({
        file: hit.filePath,
        symbol: hit.name,
        reason: "slice fetch returned null",
      });
      continue;
    }
    editableSlices.push({
      file: hit.filePath,
      symbol: hit.name,
      start_line: slice.startLine,
      end_line: slice.endLine,
      content: slice.content,
      token_count: estimateTokens(slice.content),
      content_hash: hashContent(slice.content),
    });
  }

  // 4. Dependency slices. Walk imports of each touched file up to depDepth.
  const depSlices: CodeContextSlice[] = [];
  const visitedFiles = new Set<string>(editableSlices.map((s) => s.file));

  let frontier: Array<{ file: string; depth: number }> = editableSlices.map((s) => ({ file: s.file, depth: 0 }));
  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const cur of frontier) {
      if (cur.depth >= depDepth) continue;
      const deps = await getDependencies(cur.file);
      for (const dep of deps) {
        // We only follow local-looking targets (no node_modules / absolute).
        const target = dep.target ?? dep.source ?? "";
        if (!target || target.startsWith("@") || target.includes("node_modules")) continue;
        // Try to resolve the dep target to a file in the index by matching
        // basename across `listIndexedFiles`. Cheap, deterministic.
        const baseName = target.split("/").pop() ?? target;
        const candidates = await listIndexedFiles({ pattern: `**/*${baseName}*`, limit: 5 });
        for (const cand of candidates) {
          if (visitedFiles.has(cand.path)) continue;
          visitedFiles.add(cand.path);
          // For dependency files, take the FIRST symbol in the file as the slice
          // (cheap approximation). The agent can ask for more via get_symbol if needed.
          const symHits = await findSymbols({ query: " ", filePath: cand.path, limit: 1 });
          const symHit = symHits[0];
          if (!symHit) continue;
          const slice = await getAstSlice({ symbolId: symHit.id });
          if (!slice) continue;
          depSlices.push({
            file: cand.path,
            symbol: symHit.name,
            start_line: slice.startLine,
            end_line: slice.endLine,
            content: slice.content,
            token_count: estimateTokens(slice.content),
            content_hash: hashContent(slice.content),
            dependency_depth: cur.depth + 1,
          });
          next.push({ file: cand.path, depth: cur.depth + 1 });
        }
      }
    }
    frontier = next;
  }

  // 5. Test slices.
  const testSlices: CodeContextSlice[] = [];
  if (includeTests) {
    for (const slice of editableSlices) {
      const candidates = expectedTestPathFor(slice.file);
      for (const candPath of candidates) {
        if (visitedFiles.has(candPath)) continue;
        // Confirm the path is actually in the index (avoid invented paths).
        const exists = await listIndexedFiles({ pattern: candPath, limit: 1 });
        if (exists.length === 0) continue;
        visitedFiles.add(candPath);
        const symHits = await findSymbols({ query: " ", filePath: candPath, limit: 1 });
        const symHit = symHits[0];
        if (!symHit) continue;
        const testSlice = await getAstSlice({ symbolId: symHit.id });
        if (!testSlice) continue;
        testSlices.push({
          file: candPath,
          symbol: symHit.name,
          start_line: testSlice.startLine,
          end_line: testSlice.endLine,
          content: testSlice.content,
          token_count: estimateTokens(testSlice.content),
          content_hash: hashContent(testSlice.content),
        });
      }
    }
  }

  // 6. Token budgeting. Rank slices and greedy-fill under budget.
  //
  // Score formula:
  //   editable: 100 - (token_count * 0.01)
  //   dep:      50 - (dep_depth * 10) - (token_count * 0.01)
  //   test:     40 - (token_count * 0.01)
  type Ranked = { slice: CodeContextSlice; kind: "editable" | "dep" | "test"; score: number };
  const ranked: Ranked[] = [
    ...editableSlices.map((s) => ({ slice: s, kind: "editable" as const, score: 100 - s.token_count * 0.01 })),
    ...depSlices.map((s) => ({ slice: s, kind: "dep" as const, score: 50 - (s.dependency_depth ?? 1) * 10 - s.token_count * 0.01 })),
    ...testSlices.map((s) => ({ slice: s, kind: "test" as const, score: 40 - s.token_count * 0.01 })),
  ].sort((a, b) => b.score - a.score);

  const selectedEditable: CodeContextSlice[] = [];
  const selectedDep: CodeContextSlice[] = [];
  const selectedTest: CodeContextSlice[] = [];
  let used = 0;
  for (const r of ranked) {
    if (used + r.slice.token_count > budget) {
      excluded.push({
        file: r.slice.file,
        symbol: r.slice.symbol,
        reason: `over token budget (${used + r.slice.token_count} > ${budget})`,
        estimated_tokens_avoided: r.slice.token_count,
      });
      continue;
    }
    used += r.slice.token_count;
    if (r.kind === "editable") selectedEditable.push(r.slice);
    else if (r.kind === "dep") selectedDep.push(r.slice);
    else selectedTest.push(r.slice);
  }

  // 7. Raw estimate = what the agent would have spent reading full files of
  //    every touched file. We approximate as sum of `size` from the index.
  const fileSizes = new Map<string, number>();
  for (const f of editableSlices) fileSizes.set(f.file, 0);
  for (const f of depSlices) fileSizes.set(f.file, 0);
  for (const f of testSlices) fileSizes.set(f.file, 0);
  for (const fpath of fileSizes.keys()) {
    const found = await listIndexedFiles({ pattern: fpath, limit: 1 });
    if (found.length > 0) fileSizes.set(fpath, found[0].size);
  }
  const rawEstimate = [...fileSizes.values()].reduce((s, v) => s + estimateTokens(" ".repeat(v)), 0);
  const optimizedEstimate = used;
  const tokensSaved = Math.max(0, rawEstimate - optimizedEstimate);
  const percentSaved = rawEstimate > 0 ? Math.round((tokensSaved / rawEstimate) * 10000) / 100 : 0;

  // 8. Task intent classifier (cheap keyword check).
  const lower = req.task_text.toLowerCase();
  const intentKind: "code_modification" | "code_read" | "unknown" =
    /\b(add|implement|fix|update|create|remove|refactor|change|modify|introduce|register)\b/.test(lower)
      ? "code_modification"
      : /\b(read|inspect|explain|describe|trace|find|where|how)\b/.test(lower)
        ? "code_read"
        : "unknown";

  const pkg: CodeContextPackage = {
    context_package_id: packageId,
    task_intent: {
      kind: intentKind,
      summary: req.task_text.length > 200 ? req.task_text.slice(0, 200) + "..." : req.task_text,
    },
    target_symbols: resolved.map((h) => ({
      symbol: h.name,
      file: h.filePath,
      language: inferLanguage(h.filePath),
      start_line: h.startLine,
      end_line: h.endLine,
      reason: `derived from task_text via findSymbols`,
    })),
    editable_slices: selectedEditable,
    dependency_slices: selectedDep,
    test_slices: selectedTest,
    excluded_context: excluded,
    optimization: {
      raw_estimate: rawEstimate,
      optimized_estimate: optimizedEstimate,
      tokens_saved: tokensSaved,
      percent_saved: percentSaved,
    },
  };

  // 9. Audit emit — METADATA ONLY. Slice content is NEVER in the event.
  emitAuditEvent({
    trace_id: req.trace_id,
    source_service: "mcp-server",
    kind: "code_context.package.created",
    capability_id: req.capability_id,
    severity: "info",
    payload: {
      context_package_id: packageId,
      task_intent_kind: intentKind,
      target_count: pkg.target_symbols.length,
      editable_count: selectedEditable.length,
      dependency_count: selectedDep.length,
      test_count: selectedTest.length,
      excluded_count: excluded.length,
      optimization: pkg.optimization,
      content_hashes: [
        ...selectedEditable.map((s) => ({ kind: "editable", file: s.file, symbol: s.symbol, hash: s.content_hash, tokens: s.token_count })),
        ...selectedDep.map((s) => ({ kind: "dep", file: s.file, symbol: s.symbol, hash: s.content_hash, tokens: s.token_count })),
        ...selectedTest.map((s) => ({ kind: "test", file: s.file, symbol: s.symbol, hash: s.content_hash, tokens: s.token_count })),
      ],
    },
  });

  return pkg;
}

function inferLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".ts") return "typescript";
  if (ext === ".tsx") return "tsx";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "javascript";
  if (ext === ".py") return "python";
  if (ext === ".java") return "java";
  if (ext === ".go") return "go";
  return "unknown";
}
