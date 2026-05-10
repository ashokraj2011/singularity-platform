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
  /** First-pass summary from docstring or leading comment. LLM summariser
   *  fills in only when this is null, keeping the LLM call rate down. */
  summary?: string;
  /** M16 — name of the enclosing class for `method` symbols. Resolved to a
   *  CapabilityCodeSymbol id at write time in capability.service.ts. */
  parentClassName?: string;
}

// Strip outer quotes from a string literal node. Handles Python triple
// quotes, single/double quotes, JS template literals.
function unquoteStringText(raw: string): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith('"""') && raw.endsWith('"""')) return raw.slice(3, -3).trim() || undefined;
  if (raw.startsWith("'''") && raw.endsWith("'''")) return raw.slice(3, -3).trim() || undefined;
  if (raw.length < 2) return undefined;
  const f = raw[0], l = raw[raw.length - 1];
  if ((f === '"' || f === "'" || f === "`") && f === l) return raw.slice(1, -1).trim() || undefined;
  return undefined;
}

// Strip leading // / # / * markers AND trailing */ from a captured comment
// node's text. Joins multi-line block comments into one line.
function cleanComment(raw: string): string | undefined {
  const cleaned = raw
    .replace(/\*+\/\s*$/, "") // trailing */ in block comments
    .split("\n")
    .map((ln) => ln.replace(/^\s*(\/\/+\s?|\/\*+\s?|\*+\s?|#\s?)/, "").trim())
    .map((ln) => ln.replace(/\*+\/\s*$/, "").trim())
    .filter((ln) => ln.length > 0)
    .join(" ")
    .trim();
  return cleaned ? cleaned.slice(0, 280) : undefined;
}

// Walk back across siblings to find the nearest comment block immediately
// preceding `node`. Tree-sitter parsers expose comments as siblings, not as
// a property of the function/class node.
function summaryFromLeadingComment(node: TsNode): string | undefined {
  let cur = node.previousSibling ?? null;
  // Skip whitespace-only / decorator nodes between the comment and the def.
  let buf: string[] = [];
  while (cur) {
    const t = cur.type;
    if (
      t === "comment" || t === "block_comment" || t === "line_comment" ||
      t === "comment_block" || t === "comment_line"
    ) {
      buf.unshift(cur.text ?? "");
      cur = cur.previousSibling ?? null;
      continue;
    }
    if (t === "decorator" || t === "decorators") {
      cur = cur.previousSibling ?? null;
      continue;
    }
    break;
  }
  if (buf.length === 0) return undefined;
  return cleanComment(buf.join("\n"));
}

// Python: docstring is the first statement in the function/class body, an
// expression_statement whose first child is a string node.
function summaryFromPythonDocstring(node: TsNode): string | undefined {
  const body = node.childForFieldName("body");
  if (!body) return undefined;
  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (!child) continue;
    if (child.type !== "expression_statement") continue;
    const str = child.firstChild ?? null;
    if (!str || str.type !== "string") return undefined;
    const text = unquoteStringText(str.text ?? "");
    return text ? text.split("\n")[0].slice(0, 280) : undefined;
  }
  return undefined;
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
// reported as top-level — they're noise). Captures docstring / leading
// comment as `summary` so the LLM summariser only fires when both are absent.
function walkPython(root: TsNode): RawSymbol[] {
  const out: RawSymbol[] = [];
  function visit(node: TsNode, depth: number, parentClassName?: string) {
    const t = node.type;
    if (t === "function_definition" || t === "class_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode?.text) {
        const isMethod = depth > 0 && t === "function_definition";
        const target = node.parent?.type === "decorated_definition" ? node.parent : node;
        const summary = summaryFromPythonDocstring(node) ?? summaryFromLeadingComment(target);
        out.push({
          name: nameNode.text,
          type: isMethod ? "method" : (t === "class_definition" ? "class" : "function"),
          startLine: node.startPosition.row + 1,
          endLine:   node.endPosition.row + 1,
          summary,
          parentClassName: isMethod ? parentClassName : undefined,
        });
      }
    }
    if (t === "decorated_definition") {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c) visit(c, depth, parentClassName);
      }
      return;
    }
    if (t === "class_definition") {
      const cls = node.childForFieldName("name")?.text;
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c) visit(c, depth + 1, cls);
      }
      return;
    }
    if (t === "function_definition") {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c) visit(c, depth + 1, parentClassName);
      }
      return;
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c) visit(c, depth, parentClassName);
    }
  }
  visit(root, 0);
  return out;
}

function walkTsJs(root: TsNode, isTs: boolean): RawSymbol[] {
  const out: RawSymbol[] = [];

  // For exports, the leading comment lives above the wrapping `export_statement`,
  // not above the inner declaration. Walk up to capture it.
  function leadingCommentFor(node: TsNode): string | undefined {
    let target: TsNode = node;
    while (
      target.parent &&
      (target.parent.type === "export_statement" || target.parent.type === "export_default_statement")
    ) {
      target = target.parent;
    }
    return summaryFromLeadingComment(target);
  }

  function pushIf(
    name: string | undefined,
    type: ExtractedSymbol["symbolType"],
    node: TsNode,
    parentClassName?: string,
  ) {
    if (!name) return;
    out.push({
      name,
      type,
      startLine: node.startPosition.row + 1,
      endLine:   node.endPosition.row + 1,
      summary:   leadingCommentFor(node),
      parentClassName: type === "method" ? parentClassName : undefined,
    });
  }

  function nameOf(node: TsNode): string | undefined {
    const id = node.childForFieldName("name");
    return id?.text;
  }

  function visit(node: TsNode, depth: number, parentClassName?: string) {
    const t = node.type;

    // Top-level declarations
    if (t === "function_declaration" || t === "generator_function_declaration") {
      pushIf(nameOf(node), depth > 0 ? "method" : "function", node, parentClassName);
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
      pushIf(id?.text, "method", node, parentClassName);
    } else if (t === "lexical_declaration" || t === "variable_declaration") {
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

    // Recurse — into class bodies, statement blocks, but not into function
    // bodies (the function was already captured; nested decls are noise).
    // When entering a class body, capture the class name to thread into method
    // pushes.
    const isFnLike = t === "function_declaration" || t === "function_expression" || t === "arrow_function" || t === "method_definition";
    if (isFnLike && depth > 0) return;
    const newDepth = isFnLike || t === "class_body" ? depth + 1 : depth;
    let scopeClass = parentClassName;
    if (t === "class_declaration") scopeClass = nameOf(node) ?? parentClassName;
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c) visit(c, newDepth, scopeClass);
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
        // M15.1 — first-pass summary from docstring / leading comment when
        // available; LLM summariser fills the rest at write time.
        summary: r.summary,
        // M16 — parent class name (resolved to id at write time).
        parentClassName: r.parentClassName,
      });
    }
    tree.delete();
  }
  parser.delete();
  return out;
}
