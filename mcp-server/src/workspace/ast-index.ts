import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";
import { Parser, Language } from "web-tree-sitter";
import { config } from "../config";
import { events } from "../events/bus";
import { currentBranch, currentHeadSha } from "./git-workspace";
import { sandboxRoot, SOURCE_EXT, SKIP_DIRS, toRelativeSandboxPath } from "./sandbox";

type LangKey = "python" | "typescript" | "tsx" | "javascript";

type TreeNode = {
  type: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  namedChildCount: number;
  namedChild(index: number): TreeNode | null;
  childForFieldName(name: string): TreeNode | null;
};

interface FileToIndex {
  relPath: string;
  absPath: string;
  content: string;
  language: LangKey;
  hash: string;
  size: number;
}

export interface AstIndexStats {
  status: "READY" | "FAILED";
  indexedFiles: number;
  indexedSymbols: number;
  indexedDependencies: number;
  dbPath: string;
  branch?: string;
  headSha?: string;
  error?: string;
}

export interface SymbolHit {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature?: string;
  summary?: string;
  parentName?: string;
  score?: number;
}

const LANG_FILE: Record<LangKey, string> = {
  python: "tree-sitter-python.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
};

let SQL: SqlJsStatic | null = null;
let db: Database | null = null;
let parserInited = false;
const langCache = new Map<LangKey, Language>();
let lastStats: AstIndexStats | null = null;

function astDbPath(): string {
  return config.MCP_AST_DB_PATH
    ? path.resolve(config.MCP_AST_DB_PATH)
    : path.join(sandboxRoot(), ".singularity", "mcp-ast.sqlite");
}

async function loadSql(): Promise<SqlJsStatic> {
  if (SQL) return SQL;
  const wasmDir = path.dirname(require.resolve("sql.js/dist/sql-wasm.wasm"));
  SQL = await initSqlJs({ locateFile: (file) => path.join(wasmDir, file) });
  return SQL;
}

async function getDb(): Promise<Database> {
  if (db) return db;
  const sql = await loadSql();
  const file = astDbPath();
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    db = new sql.Database(await fs.promises.readFile(file));
  } else {
    db = new sql.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      language TEXT NOT NULL,
      size INTEGER NOT NULL,
      branch TEXT,
      head_sha TEXT,
      indexed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS symbols (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      node_type TEXT NOT NULL,
      parent_name TEXT,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      signature TEXT,
      summary TEXT,
      hash TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
    CREATE TABLE IF NOT EXISTS dependencies (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      source TEXT,
      target TEXT,
      raw TEXT,
      line INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deps_file ON dependencies(file_path);
    CREATE TABLE IF NOT EXISTS ast_slices (
      symbol_id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      node_type TEXT NOT NULL,
      node_hash TEXT NOT NULL
    );
  `);
  persistDb();
  return db;
}

function persistDb(): void {
  if (!db) return;
  fs.mkdirSync(path.dirname(astDbPath()), { recursive: true });
  fs.writeFileSync(astDbPath(), Buffer.from(db.export()));
}

async function ensureParser(): Promise<void> {
  if (!parserInited) {
    await Parser.init();
    parserInited = true;
  }
}

async function loadLanguage(lang: LangKey): Promise<Language> {
  const cached = langCache.get(lang);
  if (cached) return cached;
  await ensureParser();
  const loaded = await Language.load(resolveTreeSitterWasm(LANG_FILE[lang]));
  langCache.set(lang, loaded);
  return loaded;
}

function resolveTreeSitterWasm(file: string): string {
  const candidates = [
    path.join(__dirname, "..", "..", "node_modules", "tree-sitter-wasms", "out", file),
    path.join(process.cwd(), "node_modules", "tree-sitter-wasms", "out", file),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return require.resolve(`tree-sitter-wasms/out/${file}`, {
    paths: [path.resolve(__dirname, "..", ".."), process.cwd()],
  });
}

function detectLanguage(filePath: string): LangKey | null {
  if (filePath.endsWith(".py")) return "python";
  if (filePath.endsWith(".tsx")) return "tsx";
  if (filePath.endsWith(".ts")) return "typescript";
  if (/\.(js|jsx|mjs|cjs)$/.test(filePath)) return "javascript";
  return null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function walk(dir: string, out: FileToIndex[], byteCounter: { bytes: number }): Promise<void> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(abs, out, byteCounter);
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXT.test(entry.name)) continue;
    const stat = await fs.promises.stat(abs);
    if (stat.size > config.MCP_AST_MAX_FILE_BYTES) continue;
    if (byteCounter.bytes + stat.size > config.MCP_AST_MAX_WORKSPACE_BYTES) return;
    const content = await fs.promises.readFile(abs, "utf8");
    const relPath = toRelativeSandboxPath(abs);
    const language = detectLanguage(relPath);
    if (!language) continue;
    out.push({ relPath, absPath: abs, content, language, hash: sha256(content), size: stat.size });
    byteCounter.bytes += stat.size;
  }
}

function nodeText(content: string, node: TreeNode): string {
  return content.slice(node.startIndex, node.endIndex);
}

function nameOf(node: TreeNode, content: string): string | null {
  const named = node.childForFieldName("name");
  if (named) return nodeText(content, named).trim();
  for (let i = 0; i < node.namedChildCount; i += 1) {
    const c = node.namedChild(i);
    if (c?.type === "identifier" || c?.type === "property_identifier" || c?.type === "type_identifier") {
      return nodeText(content, c).trim();
    }
  }
  return null;
}

function signatureOf(content: string, startLine: number, endLine: number): string {
  const lines = content.split("\n").slice(startLine - 1, Math.min(endLine, startLine + 8));
  const joined = lines.join("\n");
  const cut = joined.search(/\{\s*$|:\s*$/m);
  const sig = (cut > 0 ? joined.slice(0, cut + 1) : lines[0] ?? "").trim();
  return sig.slice(0, 800);
}

function kindOf(node: TreeNode): string | null {
  switch (node.type) {
    case "function_definition":
    case "function_declaration":
      return "function";
    case "class_definition":
    case "class_declaration":
      return "class";
    case "method_definition":
      return "method";
    case "interface_declaration":
      return "interface";
    case "type_alias_declaration":
      return "type";
    case "enum_declaration":
      return "enum";
    case "lexical_declaration":
    case "variable_declaration":
      return "const";
    default:
      return null;
  }
}

function directDeclaratorName(node: TreeNode, content: string): string | null {
  for (let i = 0; i < node.namedChildCount; i += 1) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === "variable_declarator") {
      const n = child.childForFieldName("name");
      if (n) return nodeText(content, n).trim();
    }
  }
  return null;
}

function extractImports(root: TreeNode, content: string, filePath: string): Array<{
  id: string; filePath: string; kind: string; source?: string; target?: string; raw: string; line: number;
}> {
  const deps: Array<{ id: string; filePath: string; kind: string; source?: string; target?: string; raw: string; line: number }> = [];
  function visit(node: TreeNode): void {
    if ([
      "import_statement", "import_from_statement", "import_declaration", "export_statement",
      "export_declaration",
    ].includes(node.type)) {
      const raw = nodeText(content, node).trim().slice(0, 1000);
      const match = raw.match(/from\s+["']([^"']+)["']|import\s+["']([^"']+)["']|require\(["']([^"']+)["']\)/);
      deps.push({
        id: sha256(`${filePath}:${node.startPosition.row + 1}:${raw}`).slice(0, 32),
        filePath,
        kind: node.type.includes("export") ? "export" : "import",
        target: match?.[1] ?? match?.[2] ?? match?.[3],
        raw,
        line: node.startPosition.row + 1,
      });
    }
    for (let i = 0; i < node.namedChildCount; i += 1) {
      const child = node.namedChild(i);
      if (child) visit(child);
    }
  }
  visit(root);
  return deps;
}

function extractSymbols(root: TreeNode, content: string, filePath: string): SymbolHit[] {
  const hits: SymbolHit[] = [];
  const classStack: string[] = [];
  function visit(node: TreeNode): void {
    const kind = kindOf(node);
    let pushedClass = false;
    if (kind) {
      let name = nameOf(node, content);
      if (!name && kind === "const") name = directDeclaratorName(node, content);
      if (name) {
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const parentName = kind === "method" ? classStack[classStack.length - 1] : undefined;
        const signature = signatureOf(content, startLine, endLine);
        const id = sha256(`${filePath}:${startLine}:${endLine}:${name}:${kind}`).slice(0, 32);
        hits.push({
          id,
          name,
          kind,
          filePath,
          startLine,
          endLine,
          signature,
          parentName,
          summary: `${kind} ${name} in ${filePath}:${startLine}-${endLine}`,
        });
        if (kind === "class") {
          classStack.push(name);
          pushedClass = true;
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i += 1) {
      const child = node.namedChild(i);
      if (child) visit(child);
    }
    if (pushedClass) classStack.pop();
  }
  visit(root);
  return hits;
}

async function indexFile(file: FileToIndex): Promise<{ symbols: number; dependencies: number }> {
  const database = await getDb();
  const lang = await loadLanguage(file.language);
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(file.content);
  if (!tree) throw new Error(`tree-sitter parse returned null for ${file.relPath}`);
  const now = new Date().toISOString();
  const branch = await currentBranch();
  const headSha = await currentHeadSha();
  const symbols = extractSymbols(tree.rootNode, file.content, file.relPath);
  const deps = extractImports(tree.rootNode, file.content, file.relPath);
  database.run("BEGIN");
  try {
    database.run("DELETE FROM symbols WHERE file_path = ?", [file.relPath]);
    database.run("DELETE FROM dependencies WHERE file_path = ?", [file.relPath]);
    database.run("DELETE FROM ast_slices WHERE file_path = ?", [file.relPath]);
    database.run(
      `INSERT OR REPLACE INTO files(path, hash, language, size, branch, head_sha, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [file.relPath, file.hash, file.language, file.size, branch ?? null, headSha ?? null, now],
    );
    for (const s of symbols) {
      const sourceSlice = file.content.split("\n").slice(s.startLine - 1, s.endLine).join("\n");
      database.run(
        `INSERT OR REPLACE INTO symbols
         (id, file_path, name, kind, node_type, parent_name, start_line, end_line, signature, summary, hash, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          s.id, s.filePath, s.name, s.kind, s.kind, s.parentName ?? null, s.startLine, s.endLine,
          s.signature ?? null, s.summary ?? null, sha256(sourceSlice), now,
        ],
      );
      database.run(
        `INSERT OR REPLACE INTO ast_slices(symbol_id, file_path, start_line, end_line, node_type, node_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [s.id, s.filePath, s.startLine, s.endLine, s.kind, sha256(sourceSlice)],
      );
    }
    for (const dep of deps) {
      database.run(
        `INSERT OR REPLACE INTO dependencies(id, file_path, kind, source, target, raw, line)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [dep.id, dep.filePath, dep.kind, dep.source ?? null, dep.target ?? null, dep.raw, dep.line],
      );
    }
    database.run("COMMIT");
  } catch (err) {
    database.run("ROLLBACK");
    throw err;
  }
  persistDb();
  return { symbols: symbols.length, dependencies: deps.length };
}

export async function indexWorkspace(reason = "manual"): Promise<AstIndexStats> {
  try {
    const files: FileToIndex[] = [];
    await walk(sandboxRoot(), files, { bytes: 0 });
    let indexedSymbols = 0;
    let indexedDependencies = 0;
    for (const file of files) {
      const result = await indexFile(file);
      indexedSymbols += result.symbols;
      indexedDependencies += result.dependencies;
    }
    lastStats = {
      status: "READY",
      indexedFiles: files.length,
      indexedSymbols,
      indexedDependencies,
      dbPath: astDbPath(),
      branch: await currentBranch(),
      headSha: await currentHeadSha(),
    };
    events.publish({
      kind: reason === "startup" ? "workspace.ast.indexed" : "workspace.ast.updated",
      correlation: { mcpInvocationId: "workspace" },
      payload: { ...lastStats, reason },
    });
    return lastStats;
  } catch (err) {
    lastStats = {
      status: "FAILED",
      indexedFiles: 0,
      indexedSymbols: 0,
      indexedDependencies: 0,
      dbPath: astDbPath(),
      error: (err as Error).message,
    };
    return lastStats;
  }
}

export async function indexChangedFiles(paths: string[], reason = "changed"): Promise<AstIndexStats> {
  try {
    let indexedFiles = 0;
    let indexedSymbols = 0;
    let indexedDependencies = 0;
    for (const rel of paths) {
      if (!SOURCE_EXT.test(rel)) continue;
      const abs = path.join(sandboxRoot(), rel);
      if (!fs.existsSync(abs)) continue;
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile() || stat.size > config.MCP_AST_MAX_FILE_BYTES) continue;
      const language = detectLanguage(rel);
      if (!language) continue;
      const content = await fs.promises.readFile(abs, "utf8");
      const result = await indexFile({
        relPath: rel,
        absPath: abs,
        content,
        language,
        hash: sha256(content),
        size: stat.size,
      });
      indexedFiles += 1;
      indexedSymbols += result.symbols;
      indexedDependencies += result.dependencies;
    }
    const stats = await statsForIndex();
    lastStats = { ...stats, indexedFiles: stats.indexedFiles, indexedSymbols: stats.indexedSymbols };
    events.publish({
      kind: "workspace.ast.updated",
      correlation: { mcpInvocationId: "workspace" },
      payload: { changedFiles: indexedFiles, changedSymbols: indexedSymbols, changedDependencies: indexedDependencies, reason },
    });
    return lastStats;
  } catch (err) {
    return {
      status: "FAILED",
      indexedFiles: 0,
      indexedSymbols: 0,
      indexedDependencies: 0,
      dbPath: astDbPath(),
      error: (err as Error).message,
    };
  }
}

export async function statsForIndex(): Promise<AstIndexStats> {
  const database = await getDb();
  const files = database.exec("SELECT count(*) AS c FROM files")[0]?.values[0]?.[0] as number | undefined;
  const symbols = database.exec("SELECT count(*) AS c FROM symbols")[0]?.values[0]?.[0] as number | undefined;
  const deps = database.exec("SELECT count(*) AS c FROM dependencies")[0]?.values[0]?.[0] as number | undefined;
  return {
    status: "READY",
    indexedFiles: Number(files ?? 0),
    indexedSymbols: Number(symbols ?? 0),
    indexedDependencies: Number(deps ?? 0),
    dbPath: astDbPath(),
    branch: await currentBranch(),
    headSha: await currentHeadSha(),
  };
}

function scoreSymbol(row: SymbolHit, query: string): number {
  const q = query.toLowerCase();
  const name = row.name.toLowerCase();
  const file = row.filePath.toLowerCase();
  let score = 0;
  if (name === q) score += 100;
  if (name.includes(q)) score += 50;
  if (file.includes(q)) score += 20;
  if ((row.summary ?? "").toLowerCase().includes(q)) score += 10;
  for (const token of q.split(/\W+/).filter(Boolean)) {
    if (name.includes(token)) score += 8;
    if (file.includes(token)) score += 4;
  }
  return score;
}

export async function findSymbols(opts: {
  query: string; kind?: string; filePath?: string; limit?: number;
}): Promise<SymbolHit[]> {
  const database = await getDb();
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const rows = database.exec(
    `SELECT id, name, kind, file_path, start_line, end_line, signature, summary, parent_name
     FROM symbols`,
  )[0]?.values ?? [];
  return rows.map((r) => ({
    id: String(r[0]),
    name: String(r[1]),
    kind: String(r[2]),
    filePath: String(r[3]),
    startLine: Number(r[4]),
    endLine: Number(r[5]),
    signature: r[6] == null ? undefined : String(r[6]),
    summary: r[7] == null ? undefined : String(r[7]),
    parentName: r[8] == null ? undefined : String(r[8]),
  }))
    .filter((r) => !opts.kind || r.kind === opts.kind)
    .filter((r) => !opts.filePath || r.filePath.includes(opts.filePath))
    .map((r) => ({ ...r, score: scoreSymbol(r, opts.query) }))
    .filter((r) => (r.score ?? 0) > 0)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit);
}

export async function getSymbol(opts: { id?: string; name?: string }): Promise<SymbolHit | null> {
  const database = await getDb();
  const stmt = opts.id
    ? database.prepare(`SELECT id, name, kind, file_path, start_line, end_line, signature, summary, parent_name FROM symbols WHERE id = ? LIMIT 1`)
    : database.prepare(`SELECT id, name, kind, file_path, start_line, end_line, signature, summary, parent_name FROM symbols WHERE name = ? LIMIT 1`);
  stmt.bind([opts.id ?? opts.name ?? ""]);
  const row = stmt.step() ? stmt.get() : null;
  stmt.free();
  if (!row) return null;
  return {
    id: String(row[0]),
    name: String(row[1]),
    kind: String(row[2]),
    filePath: String(row[3]),
    startLine: Number(row[4]),
    endLine: Number(row[5]),
    signature: row[6] == null ? undefined : String(row[6]),
    summary: row[7] == null ? undefined : String(row[7]),
    parentName: row[8] == null ? undefined : String(row[8]),
  };
}

export async function getDependencies(filePath: string): Promise<Array<{
  kind: string; source?: string; target?: string; raw: string; line: number;
}>> {
  const database = await getDb();
  const stmt = database.prepare(`SELECT kind, source, target, raw, line FROM dependencies WHERE file_path = ? ORDER BY line ASC`);
  stmt.bind([filePath]);
  const out: Array<{ kind: string; source?: string; target?: string; raw: string; line: number }> = [];
  while (stmt.step()) {
    const r = stmt.get();
    out.push({
      kind: String(r[0]),
      source: r[1] == null ? undefined : String(r[1]),
      target: r[2] == null ? undefined : String(r[2]),
      raw: String(r[3]),
      line: Number(r[4]),
    });
  }
  stmt.free();
  return out;
}

export async function getAstSlice(opts: {
  symbolId?: string; name?: string; filePath?: string; startLine?: number; endLine?: number; maxBytes?: number;
}): Promise<{ filePath: string; startLine: number; endLine: number; content: string; truncated: boolean } | null> {
  let filePath = opts.filePath;
  let startLine = opts.startLine;
  let endLine = opts.endLine;
  if (!filePath || !startLine || !endLine) {
    const sym = await getSymbol({ id: opts.symbolId, name: opts.name });
    if (!sym) return null;
    filePath = sym.filePath;
    startLine = sym.startLine;
    endLine = sym.endLine;
  }
  const abs = path.join(sandboxRoot(), filePath);
  const maxBytes = Math.min(Math.max(opts.maxBytes ?? 12_000, 500), 80_000);
  const content = await fs.promises.readFile(abs, "utf8");
  const slice = content.split("\n").slice(startLine - 1, endLine).join("\n");
  return {
    filePath,
    startLine,
    endLine,
    content: slice.slice(0, maxBytes),
    truncated: slice.length > maxBytes,
  };
}

export function lastAstStats(): AstIndexStats | null {
  return lastStats;
}
