/**
 * M18 — core utility tools (Tier 1: ship by default).
 *
 * All read-only or read-from-network. Sandbox enforcement on filesystem
 * tools mirrors the M16 fs-git pattern. HTTP tools enforce an optional
 * domain allow-list via env (HTTP_TOOL_ALLOWED_DOMAINS=comma,separated).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveSandboxedPath, sandboxRoot } from "../workspace/sandbox";
import type { ToolHandler } from "./registry";

const execFileP = promisify(execFile);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "__pycache__", ".venv", "venv",
  ".next", ".turbo", ".cache", "coverage", "target",
]);

// ── HTTP allow-list ─────────────────────────────────────────────────────────

function isHostAllowed(url: string): boolean {
  const allowList = (process.env.HTTP_TOOL_ALLOWED_DOMAINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowList.length === 0) return true; // no allow-list configured → open
  try {
    const host = new URL(url).hostname;
    return allowList.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

// ── read_file ──────────────────────────────────────────────────────────────

export const readFileTool: ToolHandler = {
  descriptor: {
    name: "read_file",
    description: "Read a sandboxed file and return its text contents. For code work, prefer find_symbol/get_symbol/get_ast_slice first and use read_file only when a full file is explicitly needed.",
    natural_language: "Use this as the fallback for full-file inspection. For code tasks, first use the AST tools to retrieve symbol summaries, signatures, dependencies, and exact slices.",
    input_schema: {
      type: "object",
      properties: {
        path:    { type: "string", description: "Sandbox-relative file path" },
        max_bytes: { type: "number", description: "Truncate after N bytes (default 50000)" },
      },
      required: ["path"],
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    try {
      const rel = String(args.path ?? "");
      const max = typeof args.max_bytes === "number" && args.max_bytes > 0 ? args.max_bytes : 50_000;
      const abs = resolveSandboxedPath(rel);
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) throw new Error("not a regular file");
      const content = (await fs.promises.readFile(abs, "utf8")).slice(0, max);
      return {
        success: true,
        output: { path: rel, bytes: stat.size, truncated: stat.size > max, content },
      };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message };
    }
  },
};

// ── list_directory ──────────────────────────────────────────────────────────

export const listDirectoryTool: ToolHandler = {
  descriptor: {
    name: "list_directory",
    description: "List files and subdirectories in a sandboxed directory (skips node_modules/.git/etc).",
    natural_language: "Use this when the user wants to see what files exist in a directory.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Sandbox-relative directory path; '.' for root" },
        recursive: { type: "boolean", description: "Walk subdirectories (default false)" },
        max_entries: { type: "number", description: "Cap result count (default 200)" },
      },
      required: ["path"],
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    try {
      const rel = String(args.path ?? ".");
      const recursive = Boolean(args.recursive);
      const maxEntries = typeof args.max_entries === "number" && args.max_entries > 0 ? args.max_entries : 200;
      const root = sandboxRoot();
      const start = rel === "." ? root : resolveSandboxedPath(rel);
      const entries: Array<{ path: string; type: "file" | "dir"; size?: number }> = [];

      async function walk(d: string): Promise<void> {
        if (entries.length >= maxEntries) return;
        const items = await fs.promises.readdir(d, { withFileTypes: true });
        for (const it of items) {
          if (entries.length >= maxEntries) return;
          if (SKIP_DIRS.has(it.name)) continue;
          const full = path.join(d, it.name);
          const relTo = path.relative(root, full);
          if (it.isDirectory()) {
            entries.push({ path: relTo, type: "dir" });
            if (recursive) await walk(full);
          } else if (it.isFile()) {
            const stat = await fs.promises.stat(full);
            entries.push({ path: relTo, type: "file", size: stat.size });
          }
        }
      }
      await walk(start);
      return {
        success: true,
        output: {
          root: path.relative(root, start) || ".",
          recursive, count: entries.length, truncated: entries.length >= maxEntries,
          entries,
        },
      };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message };
    }
  },
};

// ── search_code (ripgrep) ───────────────────────────────────────────────────

export const searchCodeTool: ToolHandler = {
  descriptor: {
    name: "search_code",
    description: "Ripgrep search across the sandbox; returns file:line:text for matches.",
    natural_language: "Use this when the user asks to find code, search for a pattern, or grep something.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Pattern (literal by default; set regex=true for regex)" },
        regex: { type: "boolean", description: "Treat query as a regex (default false)" },
        path: { type: "string", description: "Sandbox-relative subdir to scope; default whole sandbox" },
        glob: { type: "string", description: "Optional glob filter (e.g. '*.ts')" },
        max_results: { type: "number", description: "Cap results (default 50)" },
      },
      required: ["query"],
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    try {
      const q = String(args.query ?? "");
      if (!q) throw new Error("query is required");
      const max = typeof args.max_results === "number" && args.max_results > 0 ? Math.min(args.max_results, 200) : 50;
      const root = sandboxRoot();
      let cwd = root;
      let target = ".";
      if (args.path) {
        const scopedPath = resolveSandboxedPath(String(args.path));
        const scopedStat = await fs.promises.stat(scopedPath).catch(() => null);
        if (scopedStat?.isFile()) {
          cwd = path.dirname(scopedPath);
          target = path.basename(scopedPath);
        } else {
          cwd = scopedPath;
        }
      }
      const argv: string[] = [
        "--no-heading", "--with-filename", "--line-number",
        "--max-count", "5", "--max-columns", "200",
        "--max-filesize", "1M",
      ];
      if (!args.regex) argv.push("--fixed-strings");
      if (args.glob) argv.push("-g", String(args.glob));
      argv.push("--", q, target);
      const { stdout } = await execFileP("rg", argv, { cwd, maxBuffer: 5 * 1024 * 1024 }).catch((err) => {
        // rg exits 1 when no matches — that's fine.
        const e = err as { code?: number; stdout?: string };
        if (e.code === 1) return { stdout: "" };
        throw err;
      });
      const lines = stdout.split("\n").filter(Boolean).slice(0, max);
      const matches = lines.map((line) => {
        const m = line.match(/^(.*?):(\d+):(.*)$/);
        if (!m) return { file: "", line: 0, text: line };
        const absPath = path.resolve(cwd, m[1]);
        return { file: path.relative(root, absPath) || m[1], line: Number(m[2]), text: m[3] };
      });
      return {
        success: true,
        output: {
          query: q, regex: Boolean(args.regex), scope: args.path ?? ".",
          count: matches.length, truncated: lines.length >= max, matches,
        },
      };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message };
    }
  },
};

// ── http_get ────────────────────────────────────────────────────────────────

export const httpGetTool: ToolHandler = {
  descriptor: {
    name: "http_get",
    description: "HTTP GET a URL; returns the response text or JSON.",
    natural_language: "Use this for read-only HTTP calls — fetch JSON APIs, download a small text file.",
    input_schema: {
      type: "object",
      properties: {
        url:      { type: "string", description: "Absolute https:// URL" },
        as_json:  { type: "boolean", description: "Parse the response as JSON (default false)" },
        max_bytes: { type: "number", description: "Truncate response after N bytes (default 100000)" },
        headers:  { type: "object", description: "Optional request headers" },
      },
      required: ["url"],
    },
    risk_level: "MEDIUM",
    requires_approval: false,
  },
  async execute(args) {
    try {
      const url = String(args.url ?? "");
      if (!url.startsWith("https://") && !url.startsWith("http://")) {
        throw new Error("only http/https URLs are supported");
      }
      if (!isHostAllowed(url)) throw new Error("host is not on HTTP_TOOL_ALLOWED_DOMAINS allow-list");
      const max = typeof args.max_bytes === "number" && args.max_bytes > 0 ? args.max_bytes : 100_000;
      const headers = (typeof args.headers === "object" && args.headers !== null) ? args.headers as Record<string, string> : {};
      const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(30_000) });
      const text = (await res.text()).slice(0, max);
      let body: unknown = text;
      if (args.as_json) {
        try { body = JSON.parse(text); } catch { /* keep as text */ }
      }
      return {
        success: true,
        output: { url, status: res.status, contentType: res.headers.get("content-type"), body },
      };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message };
    }
  },
};

// ── web_fetch (URL → readable text) ─────────────────────────────────────────

export const webFetchTool: ToolHandler = {
  descriptor: {
    name: "web_fetch",
    description: "Fetch a web page and extract the readable article text (strips nav/ads).",
    natural_language: "Use this when the user shares a URL and you need to read the page contents.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute https:// URL" },
        max_chars: { type: "number", description: "Cap returned text length (default 8000)" },
      },
      required: ["url"],
    },
    risk_level: "MEDIUM",
    requires_approval: false,
  },
  async execute(args) {
    try {
      const url = String(args.url ?? "");
      if (!url.startsWith("https://") && !url.startsWith("http://")) {
        throw new Error("only http/https URLs are supported");
      }
      if (!isHostAllowed(url)) throw new Error("host is not on HTTP_TOOL_ALLOWED_DOMAINS allow-list");
      const max = typeof args.max_chars === "number" && args.max_chars > 0 ? args.max_chars : 8_000;
      const res = await fetch(url, {
        method: "GET",
        headers: { "user-agent": "Singularity-MCP/0.1.0 web_fetch" },
        signal: AbortSignal.timeout(30_000),
      });
      const html = await res.text();
      const text = stripHtml(html).slice(0, max);
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : "";
      return {
        success: true,
        output: { url, status: res.status, title, chars: text.length, text },
      };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message };
    }
  },
};

// Tiny readability extractor: rip <script>/<style>, drop tags, collapse
// whitespace. Good enough for the LLM; no JSDOM dep.
function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
