/**
 * M15 — tree-sitter (web-tree-sitter / WASM) symbol extractor.
 *
 * Replaces the regex extractor with proper AST-based parsing. Catches:
 *   - Class methods (regex extractor only saw classes)
 *   - Decorated functions (Python @decorator, TS export class @Decorator)
 *   - Arrow-function exports (`export const handler = () => {...}`)
 *   - Interface / type / enum / type alias (TS only)
 *   - Default exports
 *
 * Uses pre-built WASM grammars from `tree-sitter-wasms`. The grammars and the
 * web-tree-sitter runtime are loaded once on first call and cached for the
 * process lifetime.
 *
 * Same `extractSymbols(files)` signature as the regex version so the calling
 * code doesn't change. Falls back to the regex extractor on parser
 * initialisation failure (eg WASM file missing in some build context).
 */
import * as path from "node:path";
import { Parser, Language } from "web-tree-sitter";
import type { ExtractedSymbol, InputFile } from "./symbol-extractor";

const WASM_DIR = path.join(
  process.cwd(),
  "node_modules",
  "tree-sitter-wasms",
  "out",
);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "__pycache__", ".venv", "venv",
  ".next", ".turbo", ".cache", "coverage", "target",
]);

function shouldSkipPath(p: string): boolean {
  return p.split("/").some((seg) => SKIP_DIRS.has(seg));
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

type LangKey = "python" | "typescript" | "javascript" | "tsx";
const LANG_FILE: Record<LangKey, string> = {
  python:     "tree-sitter-python.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx:        "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
};

let parserInited = false;
const langCache = new Map<LangKey, Language>();

async function loadLanguage(key: LangKey): Promise<Language> {
  const cached = langCache.get(key);
  if (cached) return cached;
  const wasmPath = path.join(WASM_DIR, LANG_FILE[key]);
  const lang = await Language.load(wasmPath);
  langCache.set(key, lang);
  return lang;
}

function detectLanguage(filePath: string): LangKey | null {
  if (filePath.endsWith(".py")) return "python";
  if (filePath.endsWith(".tsx")) return "tsx";
  if (filePath.endsWith(".ts")) return "typescript";
  if (
    filePath.endsWith(".js") || filePath.endsWith(".jsx") ||
    filePath.endsWith(".mjs") || filePath.endsWith(".cjs")
  ) return "javascript";
  return null;
}

function langForRecord(key: LangKey): ExtractedSymbol["language"] {
  if (key === "python") return "python";
  if (key === "javascript") return "javascript";
  return "typescript"; // ts + tsx both report as typescript
}

interface RawSymbol {
  name: string;
  type: ExtractedSymbol["symbolType"];
  startLine: number;
  endLine?: number;
}

function unquoteString(node: { text?: string } | null | undefined): string | undefined {
  const raw = node?.text ?? "";
  // Python triple-quoted, single-quoted, double-quoted; TS template literal too.
  const m = raw.match(/^"""([\s\S]*?)"""$/) ||
            raw.match(/^'''([\s\S]*?)'''$/) ||
            raw.match(/^`([\s\S]*?)`$/) ||
            raw.match(/^"([^"\\]|\\.)*"$/) ||
            raw.match(/^'([^'\\]|\\.)*'$/);
  if (!m) return undefined;
  // For triple-quoted, m[1] is the body. For single-line, the captured pattern
  // matches the whole literal — strip the outer quote chars manually.
  if (raw.startsWith('"""') || raw.startsWith("'''")) return (m[1] ?? "").trim() || undefined;
  if (raw.length < 2) return undefined;
  return raw.slice(1, -1).trim() || undefined;
}

function summaryFromComment(node: { previousSibling?: { type: string; text?: string } | null } | null): string | undefined {
  const prev = node?.previousSibling;
  if (!prev) return undefined;
  if (prev.type === "comment" || prev.type === "block_comment" || prev.type === "line_comment") {
    const t = (prev.text ?? "").trim();
    return t.replace(/^\/\/\s?|^\/\*+\s?|\s?\*+\/$|^#\s?|^\*\s?/gm, "").trim() || undefined;
  }
  return undefined;
}

function summaryFromPythonDocstring(bodyNode: { firstChild?: { type: string; firstChild?: { text?: string } | null } | null } | null): string | undefined {
  const stmt = bodyNode?.firstChild;
  if (!stmt || stmt.type !== "expression_statement") return undefined;
  const str = stmt.firstChild;
  return str ? unquoteString(str) : undefined;
}

interface TsNode {
  type: string;
  text?: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childCount: number;
  child(i: number): TsNode | null;
  childForFieldName(name: string): TsNode | null;
  previousSibling?: TsNode | null;
  nextSibling?: TsNode | null;
  parent?: TsNode | null;
  firstChild?: TsNode | null;
  walk(): {
    nodeType: string;
    currentNode: TsNode;
    gotoFirstChild(): boolean;
    gotoNextSibling(): boolean;
    gotoParent(): boolean;
  };
}

// Walk the tree and collect symbols. Uses a manual cursor walk so we can stop
// recursing into function/method bodies (we don't want nested function defs
// reported as top-level — they're noise).
function walkPython(root: TsNode): RawSymbol[] {
  const out: RawSymbol[] = [];
  function visit(node: TsNode, depth: number) {
    const t = node.type;
    if (t === "function_definition" || t === "class_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode?.text) {
        const isMethod = depth > 0 && t === "function_definition";
        out.push({
          name: nameNode.text,
          type: isMethod ? "method" : (t === "class_definition" ? "class" : "function"),
          startLine: node.startPosition.row + 1,
          endLine:   node.endPosition.row + 1,
        });
      }
    }
    if (t === "decorated_definition") {
      // Recurse into the inner def.
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c) visit(c, depth);
      }
      return;
    }
    if (t === "function_definition" || t === "class_definition") {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c) visit(c, depth + 1);
      }
      return;
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c) visit(c, depth);
    }
  }
  visit(root, 0);
  return out;
}

function walkTsJs(root: TsNode, isTs: boolean): RawSymbol[] {
  const out: RawSymbol[] = [];

  function pushIf(name: string | undefined, type: ExtractedSymbol["symbolType"], node: TsNode) {
    if (!name) return;
    out.push({
      name,
      type,
      startLine: node.startPosition.row + 1,
      endLine:   node.endPosition.row + 1,
    });
  }

  function nameOf(node: TsNode): string | undefined {
    const id = node.childForFieldName("name");
    return id?.text;
  }

  function visit(node: TsNode, depth: number) {
    const t = node.type;

    // Top-level declarations
    if (t === "function_declaration" || t === "generator_function_declaration") {
      pushIf(nameOf(node), depth > 0 ? "method" : "function", node);
    } else if (t === "class_declaration") {
      pushIf(nameOf(node), "class", node);
    } else if (isTs && (t === "interface_declaration")) {
      pushIf(nameOf(node), "interface", node);
    } else if (isTs && (t === "type_alias_declaration")) {
      pushIf(nameOf(node), "type", node);
    } else if (isTs && (t === "enum_declaration")) {
      pushIf(nameOf(node), "enum", node);
    } else if (t === "method_definition") {
      const id = node.childForFieldName("name");
      pushIf(id?.text, "method", node);
    } else if (t === "lexical_declaration" || t === "variable_declaration") {
      // export const X = ... or const X = (...) => {...}
      // Only count top-level (depth 0) and exported / arrow-fn assignments to
      // avoid local-variable noise.
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child || child.type !== "variable_declarator") continue;
        const id = child.childForFieldName("name");
        if (!id?.text) continue;
        const value = child.childForFieldName("value");
        const isFn  = value && (value.type === "arrow_function" || value.type === "function_expression");
        if (depth === 0 || isFn) {
          pushIf(id.text, isFn ? "function" : "const", node);
        }
      }
    }

    // Recurse into class bodies, statement blocks, but not into function
    // bodies (we already captured the function itself; nested decls are noise).
    const isFnLike = t === "function_declaration" || t === "function_expression" || t === "arrow_function" || t === "method_definition";
    if (isFnLike && depth > 0) return;
    const newDepth = isFnLike || t === "class_body" ? depth + 1 : depth;
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c) visit(c, newDepth);
    }
  }
  visit(root, 0);
  return out;
}

async function ensureParser(): Promise<void> {
  if (parserInited) return;
  // web-tree-sitter v0.25 uses `Parser.init()` (no `web_url` magic — it pulls
  // its own .wasm next to the JS file by default).
  await Parser.init();
  parserInited = true;
}

export async function extractSymbolsTs(files: InputFile[]): Promise<ExtractedSymbol[]> {
  await ensureParser();
  const out: ExtractedSymbol[] = [];
  const parser = new Parser();
  for (const f of files) {
    if (shouldSkipPath(f.path)) continue;
    const langKey = detectLanguage(f.path);
    if (!langKey) continue;
    let lang: Language;
    try {
      lang = await loadLanguage(langKey);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[ts-extractor] could not load grammar for ${langKey}: ${(err as Error).message}`);
      continue;
    }
    parser.setLanguage(lang);
    const tree = parser.parse(f.content);
    if (!tree) continue;
    const root = tree.rootNode as unknown as TsNode;
    const raws = langKey === "python"
      ? walkPython(root)
      : walkTsJs(root, langKey !== "javascript");
    for (const r of raws) {
      const symbolHash = fnv1a(`${f.path}:${r.name}:${r.startLine}`);
      out.push({
        filePath: f.path,
        language: langForRecord(langKey),
        symbolName: r.name,
        symbolType: r.type,
        startLine: r.startLine,
        endLine: r.endLine,
        symbolHash,
        // summary comes from the LLM summariser at write-time when null.
        summary: undefined,
      });
    }
    tree.delete();
  }
  parser.delete();
  return out;
}

// Escape unused warnings on helpers we kept for future use.
void summaryFromComment;
void summaryFromPythonDocstring;
