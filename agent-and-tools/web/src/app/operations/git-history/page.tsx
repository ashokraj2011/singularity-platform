"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Braces,
  CalendarDays,
  CheckCircle2,
  Clock,
  Code2,
  Download,
  FileCode2,
  Files,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Play,
  Search,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { apiPath, authHeaders, readResponseBody, responseMessage } from "@/lib/api";
import { CopyButton } from "@/components/ui/CopyButton";

type ExplainResponse = {
  generatedAt: string;
  repo: string;
  script: string;
  format: "markdown" | "json";
  report: string;
  parsed?: unknown;
  stderr?: string | null;
  executionPath?: string;
  servedBy?: string | null;
  durationMs?: number | null;
  toolInvocationId?: string | null;
  runtimeIdentity?: {
    userId?: string | null;
    tenantId?: string | null;
    source?: string;
  } | null;
};

function yyyyMmDd(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultSince(): string {
  const date = new Date();
  date.setDate(date.getDate() - 7);
  return yyyyMmDd(date);
}

function reportLines(report: string): string[] {
  return report.replace(/\s+$/g, "").split("\n");
}

function extractSections(report: string): Array<{ title: string; count: number }> {
  const sections: Array<{ title: string; count: number }> = [];
  for (const line of report.split("\n")) {
    const match = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (match) sections.push({ title: match[2], count: match[1].length });
  }
  return sections;
}

function lineClass(line: string): string {
  if (line.startsWith("# ")) return "text-sky-300 font-bold";
  if (line.startsWith("## ")) return "text-emerald-300 font-bold";
  if (line.startsWith("### ")) return "text-amber-200 font-semibold";
  if (line.startsWith("- ")) return "text-slate-200";
  if (line.startsWith("|")) return "text-violet-200";
  if (line.includes("`")) return "text-cyan-100";
  return "text-slate-300";
}

function downloadText(name: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function runtimeLabel(result: ExplainResponse | null): string {
  if (!result) return "Runtime Bridge";
  const path = result.executionPath ?? "runtime";
  const servedBy = result.servedBy ? ` via ${result.servedBy}` : "";
  return `${path}${servedBy}`;
}

async function explain(body: Record<string, unknown>): Promise<ExplainResponse> {
  const res = await fetch(apiPath("/api/git-history/explain"), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  const { raw, parsed } = await readResponseBody(res);
  if (!res.ok) {
    const base = responseMessage(parsed, raw, res.statusText);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const details = [obj.detail, obj.fixCommand ? `Fix: ${obj.fixCommand}` : null, obj.fixRoute ? `Route: ${obj.fixRoute}` : null]
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      throw new Error(details.length ? `${base}\n\n${details.join("\n")}` : base);
    }
    throw new Error(base);
  }
  return parsed as ExplainResponse;
}

export default function GitHistoryExplainerPage() {
  const [since, setSince] = useState(defaultSince());
  const [until, setUntil] = useState(yyyyMmDd(new Date()));
  const [paths, setPaths] = useState("agent-and-tools/web");
  const [author, setAuthor] = useState("");
  const [noMerges, setNoMerges] = useState(false);
  const [maxCommits, setMaxCommits] = useState(100);
  const [format, setFormat] = useState<"markdown" | "json">("markdown");
  const [activeTab, setActiveTab] = useState<"report" | "json" | "terminal">("report");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExplainResponse | null>(null);

  const pathList = useMemo(() => paths.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean), [paths]);
  const sections = useMemo(() => extractSections(result?.report ?? ""), [result?.report]);
  const lines = useMemo(() => reportLines(result?.report ?? ""), [result?.report]);
  const jsonText = useMemo(() => {
    if (!result) return "";
    return JSON.stringify(result.parsed ?? result, null, 2);
  }, [result]);
  const command = useMemo(() => {
    const pieces = ["bin/explain-git-history.py", JSON.stringify(since), JSON.stringify(until)];
    for (const pathItem of pathList) pieces.push("--path", JSON.stringify(pathItem));
    if (author.trim()) pieces.push("--author", JSON.stringify(author.trim()));
    if (noMerges) pieces.push("--no-merges");
    pieces.push("--max-commits", String(maxCommits), "--format", format);
    return pieces.join(" ");
  }, [author, format, maxCommits, noMerges, pathList, since, until]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const response = await explain({
        since,
        until,
        paths: pathList,
        author: author.trim() || undefined,
        noMerges,
        maxCommits,
        format,
      });
      setResult(response);
      setActiveTab(format === "json" ? "json" : "report");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Git history explanation failed.");
      setActiveTab("terminal");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="git-history-shell">
      <style jsx>{`
        .git-history-shell {
          display: grid;
          grid-template-columns: 48px minmax(250px, 320px) minmax(0, 1fr);
          min-height: calc(100vh - 96px);
          border: 1px solid #1f2937;
          border-radius: 8px;
          overflow: hidden;
          background: #0d1117;
          color: #d6deeb;
          box-shadow: 0 22px 60px rgba(15, 23, 42, 0.22);
        }
        .activity {
          background: #0b1220;
          border-right: 1px solid #1f2937;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 14px;
          padding: 12px 0;
        }
        .activity-icon {
          display: grid;
          place-items: center;
          width: 34px;
          height: 34px;
          border-radius: 7px;
          color: #94a3b8;
        }
        .activity-icon.active {
          background: #123524;
          color: #7ee787;
          box-shadow: inset 3px 0 0 #22c55e;
        }
        .explorer {
          background: #111827;
          border-right: 1px solid #1f2937;
          display: grid;
          grid-template-rows: auto 1fr auto;
          min-width: 0;
        }
        .explorer-header {
          padding: 13px 14px;
          border-bottom: 1px solid #1f2937;
        }
        .explorer-title {
          font-size: 11px;
          font-weight: 900;
          letter-spacing: 0.14em;
          color: #9ca3af;
          text-transform: uppercase;
        }
        .explorer-body {
          padding: 14px;
          overflow: auto;
        }
        .field {
          display: grid;
          gap: 6px;
          margin-bottom: 12px;
        }
        .field label {
          display: flex;
          align-items: center;
          gap: 7px;
          color: #9ca3af;
          font-size: 11px;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.1em;
        }
        .vscode-input,
        .vscode-textarea,
        .vscode-select {
          width: 100%;
          border: 1px solid #334155;
          background: #0f172a;
          color: #e5e7eb;
          border-radius: 4px;
          padding: 8px 9px;
          font-size: 13px;
          outline: none;
        }
        .vscode-textarea {
          min-height: 88px;
          resize: vertical;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        }
        .vscode-input:focus,
        .vscode-textarea:focus,
        .vscode-select:focus {
          border-color: #38bdf8;
          box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.18);
        }
        .run-button {
          width: 100%;
          justify-content: center;
          background: #238636;
          color: white;
          border: 1px solid #2ea043;
          border-radius: 4px;
          height: 38px;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          font-weight: 800;
          font-size: 13px;
        }
        .run-button:disabled {
          opacity: 0.55;
          cursor: not-allowed;
        }
        .outline-button {
          border: 1px solid #334155;
          background: #0f172a;
          color: #cbd5e1;
          border-radius: 4px;
          padding: 7px 9px;
          display: inline-flex;
          align-items: center;
          gap: 7px;
          font-size: 12px;
          font-weight: 800;
        }
        .workbench {
          min-width: 0;
          display: grid;
          grid-template-rows: auto minmax(0, 1fr) auto;
          background: #0d1117;
        }
        .titlebar {
          min-height: 44px;
          border-bottom: 1px solid #1f2937;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 0 14px;
          background: #111827;
        }
        .tabs {
          display: flex;
          gap: 1px;
          min-width: 0;
        }
        .tab {
          height: 36px;
          display: inline-flex;
          align-items: center;
          gap: 7px;
          padding: 0 13px;
          border: 1px solid transparent;
          color: #94a3b8;
          background: #0f172a;
          font-size: 12px;
          font-weight: 800;
        }
        .tab.active {
          color: #e5e7eb;
          background: #0d1117;
          border-color: #1f2937;
          border-bottom-color: #0d1117;
        }
        .editor-layout {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 280px;
          min-height: 0;
        }
        .editor {
          overflow: auto;
          min-width: 0;
          padding: 14px 0;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
          font-size: 12px;
          line-height: 1.7;
        }
        .line {
          display: grid;
          grid-template-columns: 56px minmax(0, 1fr);
          padding-right: 16px;
        }
        .line-no {
          color: #475569;
          text-align: right;
          padding-right: 14px;
          user-select: none;
        }
        .line-code {
          white-space: pre-wrap;
          word-break: break-word;
        }
        .minimap {
          border-left: 1px solid #1f2937;
          background: #0b1220;
          overflow: auto;
          padding: 14px;
        }
        .section-link {
          display: block;
          border-left: 2px solid #334155;
          padding: 6px 8px;
          color: #cbd5e1;
          font-size: 12px;
          line-height: 1.35;
          text-align: left;
        }
        .section-link.depth-1 { border-left-color: #38bdf8; }
        .section-link.depth-2 { border-left-color: #34d399; }
        .section-link.depth-3 { border-left-color: #fbbf24; }
        .statusbar {
          min-height: 28px;
          background: #064e3b;
          color: #d1fae5;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 0 12px;
          font-size: 11px;
          font-weight: 800;
        }
        .terminal-panel {
          margin: 14px;
          border: 1px solid #334155;
          border-radius: 6px;
          background: #020617;
          color: #d1d5db;
          padding: 12px;
          overflow: auto;
          white-space: pre-wrap;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
          font-size: 12px;
          line-height: 1.6;
        }
        .error {
          margin-top: 12px;
          border: 1px solid #7f1d1d;
          background: #450a0a;
          color: #fecaca;
          border-radius: 6px;
          padding: 10px;
          font-size: 12px;
          line-height: 1.5;
        }
        .quick-paths {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-bottom: 12px;
        }
        .quick-path {
          border: 1px solid #334155;
          background: #0f172a;
          color: #cbd5e1;
          border-radius: 999px;
          padding: 4px 8px;
          font-size: 11px;
          font-weight: 800;
        }
        @media (max-width: 980px) {
          .git-history-shell {
            grid-template-columns: 42px minmax(0, 1fr);
          }
          .explorer {
            grid-column: 2;
          }
          .workbench {
            grid-column: 1 / -1;
          }
          .editor-layout {
            grid-template-columns: minmax(0, 1fr);
          }
          .minimap {
            display: none;
          }
        }
      `}</style>

      <aside className="activity" aria-label="Git history activity bar">
        <span className="activity-icon active" title="Explorer"><Files size={18} /></span>
        <span className="activity-icon" title="Search"><Search size={18} /></span>
        <span className="activity-icon" title="Source control"><GitBranch size={18} /></span>
        <span className="activity-icon" title="Run"><Play size={18} /></span>
        <span className="activity-icon" title="Security"><ShieldCheck size={18} /></span>
      </aside>

      <aside className="explorer">
        <div className="explorer-header">
          <div className="explorer-title">Git Change Explainer</div>
          <p className="mt-2 text-xs leading-5 text-slate-400">
            Explain commits between dates with deterministic git history, release notes, risk signals, and verification hints.
          </p>
        </div>

        <div className="explorer-body">
          <div className="field">
            <label><CalendarDays size={13} /> Since</label>
            <input className="vscode-input" type="date" value={since} onChange={(event) => setSince(event.target.value)} />
          </div>
          <div className="field">
            <label><CalendarDays size={13} /> Until</label>
            <input className="vscode-input" type="date" value={until} onChange={(event) => setUntil(event.target.value)} />
          </div>

          <div className="field">
            <label><Files size={13} /> Path filters</label>
            <textarea className="vscode-textarea" value={paths} onChange={(event) => setPaths(event.target.value)} placeholder={"agent-and-tools/web\ncontext-fabric"} />
          </div>
          <div className="quick-paths">
            {["agent-and-tools/web", "workgraph-studio", "context-fabric", "mcp-server", "bin", "docs"].map((item) => (
              <button key={item} type="button" className="quick-path" onClick={() => setPaths(item)}>{item}</button>
            ))}
          </div>

          <div className="field">
            <label><GitCommitHorizontal size={13} /> Author filter</label>
            <input className="vscode-input" value={author} onChange={(event) => setAuthor(event.target.value)} placeholder="optional" />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="field">
              <label><Clock size={13} /> Max</label>
              <input className="vscode-input" type="number" min={1} max={500} value={maxCommits} onChange={(event) => setMaxCommits(Number(event.target.value) || 100)} />
            </div>
            <div className="field">
              <label><Braces size={13} /> Format</label>
              <select className="vscode-select" value={format} onChange={(event) => setFormat(event.target.value as "markdown" | "json")}>
                <option value="markdown">Markdown</option>
                <option value="json">JSON</option>
              </select>
            </div>
          </div>

          <label className="mb-3 flex items-center gap-2 text-xs font-bold text-slate-300">
            <input type="checkbox" checked={noMerges} onChange={(event) => setNoMerges(event.target.checked)} />
            Exclude merge commits
          </label>

          <button type="button" className="run-button" disabled={busy || !since || !until} onClick={() => void run()}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
            Explain Change Range
          </button>

          {error && (
            <div className="error">
              <div className="mb-1 flex items-center gap-2 font-black"><AlertTriangle size={14} /> Could not explain range</div>
              {error}
            </div>
          )}
        </div>

        <div className="border-t border-slate-800 p-3">
          <div className="mb-2 text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">Command</div>
          <div className="rounded border border-slate-700 bg-slate-950 p-2">
            <div className="flex items-start justify-between gap-2">
              <code className="break-all text-[11px] leading-5 text-slate-300">{command}</code>
              <CopyButton text={command} label="Copy command" />
            </div>
          </div>
        </div>
      </aside>

      <main className="workbench">
        <header className="titlebar">
          <div className="tabs">
            <button type="button" className={`tab ${activeTab === "report" ? "active" : ""}`} onClick={() => setActiveTab("report")}>
              <FileCode2 size={14} /> git-history.md
            </button>
            <button type="button" className={`tab ${activeTab === "json" ? "active" : ""}`} onClick={() => setActiveTab("json")}>
              <Braces size={14} /> git-history.json
            </button>
            <button type="button" className={`tab ${activeTab === "terminal" ? "active" : ""}`} onClick={() => setActiveTab("terminal")}>
              <Terminal size={14} /> terminal
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="outline-button" type="button" disabled={!result} onClick={() => result && downloadText(`git-history-${since}-to-${until}.${activeTab === "json" ? "json" : "md"}`, activeTab === "json" ? jsonText : result.report)}>
              <Download size={14} /> Download
            </button>
            <button className="outline-button" type="button" disabled={!result} onClick={() => result && navigator.clipboard?.writeText(activeTab === "json" ? jsonText : result.report)}>
              <Code2 size={14} /> Copy
            </button>
          </div>
        </header>

        {activeTab === "terminal" ? (
          <div className="terminal-panel">
            {error ? `ERROR: ${error}\n\n` : ""}
            {result ? `Generated: ${result.generatedAt}\nRepo: ${result.repo}\nExecution: ${runtimeLabel(result)}\nRuntime user: ${result.runtimeIdentity?.userId ?? "n/a"}\nRuntime tenant: ${result.runtimeIdentity?.tenantId ?? "n/a"}\nTool invocation: ${result.toolInvocationId ?? "n/a"}\nDuration: ${result.durationMs ?? "n/a"} ms\nScript/tool: ${result.script}\nFormat: ${result.format}\n\n${result.stderr ? `stderr:\n${result.stderr}\n\n` : ""}${command}` : command}
          </div>
        ) : (
          <section className="editor-layout">
            <div className="editor" aria-label="Git history report editor">
              {(activeTab === "json" ? reportLines(jsonText) : lines).map((line, index) => (
                <div className="line" key={`${index}-${line.slice(0, 20)}`}>
                  <span className="line-no">{index + 1}</span>
                  <span className={`line-code ${activeTab === "json" ? "text-cyan-100" : lineClass(line)}`}>{line || " "}</span>
                </div>
              ))}
              {!result && (
                <div className="px-8 py-10">
                  <div className="mb-3 inline-grid h-12 w-12 place-items-center rounded-lg bg-emerald-950 text-emerald-300">
                    <GitBranch size={22} />
                  </div>
                  <h1 className="text-2xl font-black text-slate-100">Explain changes from git history</h1>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
                    Pick a date range and path scope, then generate a markdown or JSON explanation. The output is ready for release notes, evidence packs, or governance review.
                  </p>
                </div>
              )}
            </div>

            <aside className="minimap">
              <div className="mb-3 flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-slate-500">
                <FileCode2 size={13} />
                Outline
              </div>
              {sections.length ? sections.map((section, index) => (
                <button key={`${section.title}-${index}`} type="button" className={`section-link depth-${section.count}`}>
                  {section.title}
                </button>
              )) : (
                <p className="text-xs leading-5 text-slate-500">No report generated yet.</p>
              )}
            </aside>
          </section>
        )}

        <footer className="statusbar">
          <span className="inline-flex items-center gap-2">
            {result ? <CheckCircle2 size={13} /> : <GitBranch size={13} />}
            {result ? `Generated ${result.generatedAt}` : "Ready"}
          </span>
          <span>{runtimeLabel(result)} · {pathList.length ? `${pathList.length} path filter(s)` : "entire repository"} · {format}</span>
        </footer>
      </main>
    </div>
  );
}
