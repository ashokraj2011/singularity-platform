/**
 * M99 S1.2 — six AER tools for the "Centralize Agentic Coding Around Context
 * Fabric" spec.
 *
 *   localize_code_change            (read)     — find edit sites for a task
 *   localize_test_failure           (read)     — find source+test files from failure output
 *   replace_method_or_function      (mutate)   — swap a whole symbol body
 *   insert_switch_case_or_enum_handler (mutate) — add a case/branch at an anchor
 *   add_test_case                   (mutate)   — append/create a test case
 *   git_push_preflight              (analyzer) — classify push viability BEFORE pushing
 *
 * Design: these are THIN COMPOSERS over already-tested primitives rather than
 * fresh fs/git/AST implementations. The localizers + mutators delegate to the
 * AST index (findSymbols/getAstSlice) and the M16 sandboxed edit tools
 * (replace_range / write_file); the preflight reuses git-workspace's
 * classifyPushError + fixCommandsForPushBlock against a `git push --dry-run`.
 * Keeping them compositional means the sandbox/escape/conflict guarantees of
 * the underlying tools carry through unchanged.
 *
 * Registration is feature-flagged: registry.ts only adds these when
 * CF_AGENTIC_CODING_V2_ENABLED is truthy, so they ship dark (mirrors the CF
 * env-gate; the tool descriptors live in tools.json regardless so the registry
 * drift check stays green).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolHandler } from "./registry";
import { findSymbols, getSymbol, getAstSlice } from "../workspace/ast-index";
import { sandboxRoot } from "../workspace/sandbox";
import {
  classifyPushError,
  fixCommandsForPushBlock,
  ensureGitRepo,
} from "../workspace/git-workspace";
import { replaceRangeTool, writeFileTool } from "./fs-git";
import { readFileTool } from "./core";
import { config } from "../config";

const execFileP = promisify(execFile);
const GIT_PUSH_PREFLIGHT_TIMEOUT_MS = config.MCP_WORKTREE_GIT_WRITE_TIMEOUT_MS;

// ── shared helpers ───────────────────────────────────────────────────────────

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => asString(x)).filter(Boolean) : [];
}

const TEST_PATH_RE = /(test|spec)/i;

function looksLikeTest(p: string): boolean {
  return TEST_PATH_RE.test(p);
}

/** Pull plausible file paths out of free-form text (stack traces, logs). */
function extractPathsFromText(text: string): string[] {
  const out = new Set<string>();
  // matches a/b/c.ext and a/b/c.ext:123 forms
  const re = /([\w./-]+\.[A-Za-z0-9]{1,6})(?::\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = m[1];
    if (p.includes("/") || p.includes(".")) out.add(p);
    if (out.size >= 50) break;
  }
  return [...out];
}

// ── localizers (read) ─────────────────────────────────────────────────────────

export const localizeCodeChangeTool: ToolHandler = {
  descriptor: {
    name: "localize_code_change",
    description:
      "Localize the files/symbols most relevant to a described change, using the AST symbol index. Returns ranked targets so you can edit a focused set instead of reading the whole repo.",
    natural_language:
      "Use this at the start of a coding task to find WHERE to make a change before editing. Supply the task description and any known symbol names.",
    input_schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Natural-language description of the change to localize." },
        symbols: { type: "array", items: { type: "string" }, description: "Known symbol/identifier names to anchor the search." },
        hint_paths: { type: "array", items: { type: "string" }, description: "Paths the caller already suspects are relevant." },
      },
      required: ["task"],
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    const task = asString(args.task);
    if (!task) return { success: false, output: null, error_code: "VALIDATION", error: "task is required" };
    const symbols = asStringArray(args.symbols);
    const hintPaths = asStringArray(args.hint_paths);

    const queries = [task, ...symbols];
    const hitMap = new Map<string, { file: string; symbol: string; kind: string; score: number }>();
    for (const q of queries) {
      const hits = await findSymbols({ query: q, limit: 15 });
      for (const h of hits) {
        const key = `${h.filePath}#${h.name}`;
        if (!hitMap.has(key)) {
          hitMap.set(key, { file: h.filePath, symbol: h.name, kind: h.kind, score: h.score ?? 0 });
        }
      }
    }
    const ranked = [...hitMap.values()].sort((a, b) => b.score - a.score).slice(0, 25);
    const files = new Set<string>([...hintPaths, ...ranked.map((r) => r.file)]);
    const targetFiles = [...files].filter((f) => !looksLikeTest(f));
    const targetTests = [...files].filter(looksLikeTest);
    return {
      success: true,
      output: {
        task,
        target_files: targetFiles,
        target_tests: targetTests,
        target_symbols: ranked.map((r) => r.symbol),
        ranked,
        source: "ast_index",
      },
    };
  },
};

export const localizeTestFailureTool: ToolHandler = {
  descriptor: {
    name: "localize_test_failure",
    description:
      "Localize the source + test files implicated by raw test/stack-trace output. Combines path extraction from the failure text with AST symbol lookup.",
    natural_language:
      "Use this when a test run failed and you need to find which files to fix. Paste the failure output.",
    input_schema: {
      type: "object",
      properties: {
        failure_output: { type: "string", description: "Raw test/stack-trace output." },
        failing_tests: { type: "array", items: { type: "string" }, description: "Explicit failing test names." },
      },
      required: ["failure_output"],
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    const failureOutput = asString(args.failure_output);
    if (!failureOutput) {
      return { success: false, output: null, error_code: "VALIDATION", error: "failure_output is required" };
    }
    const failingTests = asStringArray(args.failing_tests);
    const pathsFromText = extractPathsFromText(failureOutput);

    // Try to anchor on named tests via the symbol index too.
    const symbolHits = new Set<string>();
    for (const t of failingTests.slice(0, 10)) {
      const hits = await findSymbols({ query: t, limit: 5 });
      for (const h of hits) symbolHits.add(h.filePath);
    }
    const all = new Set<string>([...pathsFromText, ...symbolHits]);
    return {
      success: true,
      output: {
        suspect_source_files: [...all].filter((p) => !looksLikeTest(p)),
        suspect_test_files: [...all].filter(looksLikeTest),
        failing_tests: failingTests,
        paths_from_output: pathsFromText,
        source: "failure_text+ast_index",
      },
    };
  },
};

// ── structured mutators (mutate) ───────────────────────────────────────────────
//
// These resolve a symbol's exact line range from the AST index, then delegate
// the actual write to the M16 replace_range / write_file tools so the sandbox
// + conflict + provenance guarantees carry through unchanged.

export const replaceMethodOrFunctionTool: ToolHandler = {
  descriptor: {
    name: "replace_method_or_function",
    description:
      "Replace an entire method/function body, located by symbol name via the AST index. Safer than a free-form anchor edit — the line range comes from the parsed symbol, not guessed text.",
    natural_language:
      "Use this to rewrite a whole function or method. Provide the file, the symbol name, and the full replacement source.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File containing the method/function." },
        symbol: { type: "string", description: "Name of the method or function to replace (optionally Class.method)." },
        new_body: { type: "string", description: "Full replacement source for the entire definition." },
      },
      required: ["path", "symbol", "new_body"],
    },
    risk_level: "MEDIUM",
    requires_approval: false,
  },
  async execute(args) {
    const path = asString(args.path);
    const symbol = asString(args.symbol);
    const newBody = asString(args.new_body);
    if (!path || !symbol || !newBody) {
      return { success: false, output: null, error_code: "VALIDATION", error: "path, symbol and new_body are required" };
    }
    // Locate the symbol's line range. Prefer an exact name match; fall back
    // to a filtered search within the target file.
    const bare = symbol.includes(".") ? symbol.split(".").pop()! : symbol;
    let sym = await getSymbol({ name: bare });
    if (!sym || !sym.filePath.includes(path)) {
      const hits = await findSymbols({ query: bare, filePath: path, limit: 1 });
      sym = hits[0] ?? sym;
    }
    if (!sym) {
      return {
        success: false,
        output: null,
        error_code: "CONFLICT",
        error: `symbol '${symbol}' not found in the AST index; run repo_map/find_symbol first or use replace_range with explicit lines`,
      };
    }
    // Delegate the write to the tested replace_range tool.
    return replaceRangeTool.execute({
      path: sym.filePath,
      startLine: sym.startLine,
      endLine: sym.endLine,
      replacement: newBody,
    });
  },
};

export const insertSwitchCaseOrEnumHandlerTool: ToolHandler = {
  descriptor: {
    name: "insert_switch_case_or_enum_handler",
    description:
      "Insert a new case/branch/enum-member at an anchor symbol. Locates the anchor's range via the AST index and inserts the new case body just before the construct's closing line.",
    natural_language:
      "Use this to extend a switch statement, enum, or dispatch map with a new case. Provide the file, the anchor symbol, the case key, and the case body.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File containing the switch/enum/dispatch construct." },
        anchor: { type: "string", description: "Symbol identifying the construct to extend." },
        case_key: { type: "string", description: "The new case label / enum member / dispatch key." },
        case_body: { type: "string", description: "Source for the new case/branch body." },
      },
      required: ["path", "anchor", "case_key", "case_body"],
    },
    risk_level: "MEDIUM",
    requires_approval: false,
  },
  async execute(args) {
    const path = asString(args.path);
    const anchor = asString(args.anchor);
    const caseKey = asString(args.case_key);
    const caseBody = asString(args.case_body);
    if (!path || !anchor || !caseKey || !caseBody) {
      return { success: false, output: null, error_code: "VALIDATION", error: "path, anchor, case_key and case_body are required" };
    }
    const bare = anchor.includes(".") ? anchor.split(".").pop()! : anchor;
    let sym = await getSymbol({ name: bare });
    if (!sym || !sym.filePath.includes(path)) {
      const hits = await findSymbols({ query: bare, filePath: path, limit: 1 });
      sym = hits[0] ?? sym;
    }
    if (!sym) {
      return {
        success: false,
        output: null,
        error_code: "CONFLICT",
        error: `anchor '${anchor}' not found in the AST index; use replace_range with explicit lines instead`,
      };
    }
    // Read the construct's slice to find the last non-empty line (the closing
    // brace/bracket). Insert the new case immediately before it.
    const slice = await getAstSlice({ filePath: sym.filePath, startLine: sym.startLine, endLine: sym.endLine });
    if (!slice) {
      return { success: false, output: null, error_code: "CONFLICT", error: "could not read anchor slice" };
    }
    const lines = slice.content.split("\n");
    // index (within the slice) of the last non-blank line — assumed closer.
    let closerIdx = lines.length - 1;
    while (closerIdx > 0 && lines[closerIdx].trim() === "") closerIdx--;
    const closingLineNo = sym.startLine + closerIdx; // 1-based absolute
    const indent = (lines[closerIdx].match(/^\s*/)?.[0] ?? "") + "  ";
    const insertText = caseBody
      .split("\n")
      .map((l) => (l.length ? indent + l : l))
      .join("\n");
    // Replace the single closing line with [new case body] + [closing line].
    const closingLineText = lines[closerIdx];
    return replaceRangeTool.execute({
      path: sym.filePath,
      startLine: closingLineNo,
      endLine: closingLineNo,
      replacement: `${insertText}\n${closingLineText}`,
    });
  },
};

export const addTestCaseTool: ToolHandler = {
  descriptor: {
    name: "add_test_case",
    description:
      "Append a test case to a test file (creates the file if absent). Appends to the end of the file; for nesting inside an existing suite use replace_range after locating the suite.",
    natural_language:
      "Use this to add a regression or coverage test. Provide the test file path, a name, and the full test body.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Test file to add the case to (created if absent)." },
        test_name: { type: "string", description: "Name/description of the new test case." },
        test_body: { type: "string", description: "Full source of the new test case." },
        suite: { type: "string", description: "Optional describe/suite block name (advisory; appended as a comment header)." },
      },
      required: ["path", "test_name", "test_body"],
    },
    risk_level: "MEDIUM",
    requires_approval: false,
  },
  async execute(args) {
    const path = asString(args.path);
    const testName = asString(args.test_name);
    const testBody = asString(args.test_body);
    const suite = asString(args.suite);
    if (!path || !testName || !testBody) {
      return { success: false, output: null, error_code: "VALIDATION", error: "path, test_name and test_body are required" };
    }
    // Read existing content (empty if the file doesn't exist yet).
    let existing = "";
    const readResult = await readFileTool.execute({ path });
    if (readResult.success && readResult.output && typeof readResult.output === "object") {
      const content = (readResult.output as { content?: unknown }).content;
      existing = typeof content === "string" ? content : "";
    }
    const header = suite ? `\n// suite: ${suite}\n` : "\n";
    const appended = `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${header}// test: ${testName}\n${testBody}\n`;
    // Delegate the write to the tested write_file tool (full replacement).
    return writeFileTool.execute({ path, content: appended });
  },
};

// ── git push preflight (analyzer) ──────────────────────────────────────────────

export const gitPushPreflightTool: ToolHandler = {
  descriptor: {
    name: "git_push_preflight",
    description:
      "Classify whether a push will succeed BEFORE attempting it. Runs `git push --dry-run` and maps any failure to a discrete blocked_code with fix commands, so auth/branch problems surface early.",
    natural_language:
      "Use this before the push stage to check the branch can actually be pushed (token present, scope sufficient, branch not protected, upstream set).",
    input_schema: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Local branch intended for push." },
        remote: { type: "string", description: "Target remote (default 'origin')." },
      },
      required: [],
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    const remote = asString(args.remote) || config.MCP_GIT_PUSH_REMOTE || "origin";
    let branch = asString(args.branch);
    const cwd = sandboxRoot();
    try {
      await ensureGitRepo();
      if (!branch) {
        const { stdout } = await execFileP("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd,
          timeout: GIT_PUSH_PREFLIGHT_TIMEOUT_MS,
        });
        branch = stdout.trim();
      }
      // Does the local branch have any commit to push at all?
      let hasCommit = true;
      try {
        const { stdout } = await execFileP("git", ["rev-list", "--count", branch], {
          cwd,
          timeout: GIT_PUSH_PREFLIGHT_TIMEOUT_MS,
        });
        hasCommit = Number(stdout.trim()) > 0;
      } catch {
        hasCommit = false;
      }
      if (!hasCommit) {
        const code = "NO_COMMIT_TO_PUSH" as const;
        return {
          success: true,
          output: {
            ok: false, remote, branch, blocked_code: code, has_commit: false,
            fix_commands: fixCommandsForPushBlock(code, remote),
            retryable: true,
            message: "Branch has no commits to push.",
          },
        };
      }
      // Dry-run the push. Success → preflight passes.
      await execFileP("git", ["push", "--dry-run", "-u", remote, branch], {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        timeout: GIT_PUSH_PREFLIGHT_TIMEOUT_MS,
      });
      return {
        success: true,
        output: { ok: true, remote, branch, has_commit: true, message: "Push preflight passed (dry-run clean)." },
      };
    } catch (err) {
      const message = (err as Error).message || String(err);
      const code = classifyPushError(message);
      return {
        success: true, // the TOOL succeeded; it produced a classification
        output: {
          ok: false,
          remote,
          branch,
          blocked_code: code,
          fix_commands: fixCommandsForPushBlock(code, remote),
          retryable: code !== "GIT_BRANCH_PROTECTED",
          message,
        },
      };
    }
  },
};

/** All six M99 tools, in registration order. */
export const M99_TOOLS: ToolHandler[] = [
  localizeCodeChangeTool,
  localizeTestFailureTool,
  replaceMethodOrFunctionTool,
  insertSwitchCaseOrEnumHandlerTool,
  addTestCaseTool,
  gitPushPreflightTool,
];
