import * as fs from "node:fs";
import * as path from "node:path";

export interface DetectedVerifier {
  name: string;
  command: string;
  args: string[];               // static args; changed paths appended for per-file verifiers
  kind: "lint" | "typecheck" | "test" | "compile";
  detectedFrom: string;
  timeout_ms: number;
  filePatterns: string[];
  perFile: boolean;              // true = append changed file paths to args
}

let cachedVerifiers: DetectedVerifier[] | null = null;
let cachedVerifiersAt = 0;
const CACHE_TTL_MS = 60_000;

export function clearVerifierCache(): void {
  cachedVerifiers = null;
  cachedVerifiersAt = 0;
}

export async function detectVerifiers(workspaceRoot: string): Promise<DetectedVerifier[]> {
  if (cachedVerifiers && Date.now() - cachedVerifiersAt < CACHE_TTL_MS) return cachedVerifiers;

  const verifiers: DetectedVerifier[] = [];

  // ── package.json scripts ──
  const pkgPath = path.join(workspaceRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await fs.promises.readFile(pkgPath, "utf8"));
      const scripts = pkg.scripts ?? {};
      if (scripts.typecheck || scripts["type-check"]) {
        verifiers.push({
          name: "typecheck", command: "npm",
          args: ["run", scripts.typecheck ? "typecheck" : "type-check"],
          kind: "typecheck", detectedFrom: "package.json", timeout_ms: 30_000,
          filePatterns: [".ts", ".tsx"], perFile: false,
        });
      }
      if (scripts.lint) {
        verifiers.push({
          name: "lint", command: "npm", args: ["run", "lint"],
          kind: "lint", detectedFrom: "package.json", timeout_ms: 15_000,
          filePatterns: [".ts", ".tsx", ".js", ".jsx"], perFile: false,
        });
      }
      if (scripts.test) {
        verifiers.push({
          name: "test", command: "npm", args: ["test"],
          kind: "test", detectedFrom: "package.json", timeout_ms: 60_000,
          filePatterns: [".ts", ".tsx", ".js", ".jsx"], perFile: false,
        });
      }
      if (scripts.check) {
        verifiers.push({
          name: "check", command: "npm", args: ["run", "check"],
          kind: "lint", detectedFrom: "package.json", timeout_ms: 15_000,
          filePatterns: [".ts", ".tsx", ".js", ".jsx"], perFile: false,
        });
      }
    } catch { /* malformed package.json — skip */ }
  }

  // ── Python: py_compile per-file + pytest project-level ──
  const hasPython = fs.existsSync(path.join(workspaceRoot, "pyproject.toml"))
    || fs.existsSync(path.join(workspaceRoot, "setup.py"))
    || fs.existsSync(path.join(workspaceRoot, "requirements.txt"));
  if (hasPython) {
    verifiers.push({
      name: "py_compile", command: "python3", args: ["-m", "py_compile"],
      kind: "compile", detectedFrom: "python-project", timeout_ms: 10_000,
      filePatterns: [".py"], perFile: true,
    });
    verifiers.push({
      name: "pytest", command: "pytest", args: ["--tb=short", "-q"],
      kind: "test", detectedFrom: "python-project", timeout_ms: 60_000,
      filePatterns: [".py"], perFile: false,
    });
  }

  // ── Go ──
  if (fs.existsSync(path.join(workspaceRoot, "go.mod"))) {
    verifiers.push({
      name: "go-vet", command: "go", args: ["vet", "./..."],
      kind: "lint", detectedFrom: "go.mod", timeout_ms: 30_000,
      filePatterns: [".go"], perFile: false,
    });
  }

  // ── Rust ──
  if (fs.existsSync(path.join(workspaceRoot, "Cargo.toml"))) {
    verifiers.push({
      name: "cargo-check", command: "cargo", args: ["check"],
      kind: "compile", detectedFrom: "Cargo.toml", timeout_ms: 60_000,
      filePatterns: [".rs"], perFile: false,
    });
  }

  // ── Maven ──
  if (fs.existsSync(path.join(workspaceRoot, "pom.xml"))) {
    verifiers.push({
      name: "mvn-compile", command: "mvn", args: ["compile"],
      kind: "compile", detectedFrom: "pom.xml", timeout_ms: 120_000,
      filePatterns: [".java"], perFile: false,
    });
  }

  cachedVerifiers = verifiers;
  cachedVerifiersAt = Date.now();
  return verifiers;
}
