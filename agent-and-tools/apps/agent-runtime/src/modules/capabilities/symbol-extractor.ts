/**
 * M14 — regex-based code-symbol extractor (v0).
 *
 * Walks a list of {path, content} records and produces ExtractedSymbol rows.
 * Languages supported in v0:
 *   - Python (.py)        — `def Foo(...)`, `class Bar(...)`
 *   - TypeScript (.ts/.tsx) — `function`, `class`, `interface`, `type`, `const X = `, `enum`
 *   - JavaScript (.js/.jsx) — same shape as TS minus `interface|type|enum`
 *
 * Tree-sitter is the v1 upgrade — handles nested classes / decorators /
 * arrow-function exports / re-exports / module augmentation correctly. This
 * v0 deliberately misses those edge cases in exchange for zero deps and a
 * predictable, debuggable surface.
 *
 * Each symbol carries `summary` extracted from the line immediately above
 * (single-line comment or single-line docstring). Multi-line docstrings are
 * captured up to the first closing `"""` for Python.
 */

export interface InputFile {
  path: string;
  content: string;
}

export interface ExtractedSymbol {
  filePath: string;
  language: "python" | "typescript" | "javascript";
  symbolName: string;
  symbolType: "function" | "class" | "interface" | "type" | "enum" | "const" | "method";
  startLine: number;
  endLine?: number;
  summary?: string;
  symbolHash: string;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "__pycache__", ".venv", "venv",
  ".next", ".turbo", ".cache", "coverage", "target",
]);

function shouldSkipPath(p: string): boolean {
  return p.split("/").some((seg) => SKIP_DIRS.has(seg));
}

function detectLanguage(path: string): ExtractedSymbol["language"] | null {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx") || path.endsWith(".mjs") || path.endsWith(".cjs")) return "javascript";
  return null;
}

function fnv1a(s: string): string {
  // Tiny, dependency-free hash. Good enough for symbolHash dedup keys.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

interface SymbolMatch {
  name: string;
  type: ExtractedSymbol["symbolType"];
  startLine: number;
}

function extractPython(content: string): SymbolMatch[] {
  const out: SymbolMatch[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:async\s+)?(def|class)\s+([A-Za-z_][\w]*)/);
    if (m) out.push({ name: m[2], type: m[1] === "class" ? "class" : "function", startLine: i + 1 });
  }
  return out;
}

function extractTsJs(content: string, isTs: boolean): SymbolMatch[] {
  const out: SymbolMatch[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // function / class / interface / type / enum / const at top level (no leading whitespace-only continuation matters; allow `export`).
    let m = line.match(/^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_][\w]*)/);
    if (m) { out.push({ name: m[1], type: "function", startLine: i + 1 }); continue; }
    m = line.match(/^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_][\w]*)/);
    if (m) { out.push({ name: m[1], type: "class", startLine: i + 1 }); continue; }
    if (isTs) {
      m = line.match(/^\s*(?:export\s+)?interface\s+([A-Za-z_][\w]*)/);
      if (m) { out.push({ name: m[1], type: "interface", startLine: i + 1 }); continue; }
      m = line.match(/^\s*(?:export\s+)?type\s+([A-Za-z_][\w]*)\s*=/);
      if (m) { out.push({ name: m[1], type: "type", startLine: i + 1 }); continue; }
      m = line.match(/^\s*(?:export\s+)?enum\s+([A-Za-z_][\w]*)/);
      if (m) { out.push({ name: m[1], type: "enum", startLine: i + 1 }); continue; }
    }
    // const X = (arrow function or value). Only top-level (no leading ws) to limit noise.
    m = line.match(/^(?:export\s+)?const\s+([A-Za-z_][\w]*)\s*[:=]/);
    if (m) { out.push({ name: m[1], type: "const", startLine: i + 1 }); }
  }
  return out;
}

function summaryFor(content: string, line: number, lang: ExtractedSymbol["language"]): string | undefined {
  const lines = content.split("\n");
  // Python: line AFTER `def`/`class` may start a triple-quoted docstring.
  if (lang === "python") {
    for (let i = line; i < Math.min(line + 4, lines.length); i++) {
      const m = lines[i].match(/^\s*"""\s*(.*)$/);
      if (m) {
        let buf = m[1];
        if (buf.endsWith('"""')) return buf.slice(0, -3).trim() || undefined;
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          const trimmed = lines[j].trim();
          if (trimmed.endsWith('"""')) {
            buf += "\n" + trimmed.slice(0, -3);
            return buf.trim() || undefined;
          }
          buf += "\n" + trimmed;
        }
        return buf.trim() || undefined;
      }
    }
  }
  // Comment immediately above the symbol.
  if (line - 2 >= 0) {
    const prev = lines[line - 2];
    const m =
      prev.match(/^\s*\/\/\s*(.+)$/) ||
      prev.match(/^\s*\*\s*(.+)$/) ||
      prev.match(/^\s*#\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return undefined;
}

export function extractSymbols(files: InputFile[]): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  for (const f of files) {
    if (shouldSkipPath(f.path)) continue;
    const lang = detectLanguage(f.path);
    if (!lang) continue;
    const matches =
      lang === "python" ? extractPython(f.content) :
      lang === "typescript" ? extractTsJs(f.content, true) :
      extractTsJs(f.content, false);
    for (const m of matches) {
      const summary = summaryFor(f.content, m.startLine, lang);
      const symbolHash = fnv1a(`${f.path}:${m.name}:${m.startLine}`);
      out.push({
        filePath: f.path,
        language: lang,
        symbolName: m.name,
        symbolType: m.type,
        startLine: m.startLine,
        summary,
        symbolHash,
      });
    }
  }
  return out;
}
