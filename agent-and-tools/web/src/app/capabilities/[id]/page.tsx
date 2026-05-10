"use client";
import { useRef, useState } from "react";
import useSWR from "swr";
import { runtimeApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Plus, Upload } from "lucide-react";

export default function CapabilityDetailPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id);
  const { data: cap, mutate: mutateCap } = useSWR(`cap-${id}`, () => runtimeApi.getCapability(id));
  const { data: templates } = useSWR("runtime-tmpl-options", () => runtimeApi.listTemplates());

  const [tab, setTab] = useState<"bindings" | "repos" | "knowledge" | "code" | "sources" | "tuning">("bindings");

  // Forms
  const [repo, setRepo] = useState({ repoName: "", repoUrl: "", defaultBranch: "main", repositoryType: "GITHUB" });
  const [bind, setBind] = useState({ agentTemplateId: "", bindingName: "", roleInCapability: "" });
  const [know, setKnow] = useState({ artifactType: "ARCHITECTURE_SUMMARY", title: "", content: "", confidence: 0.8 });

  if (!cap) return <div className="text-slate-500">Loading…</div>;
  const c = cap as Record<string, unknown>;
  const repos = (c.repositories as Array<Record<string, unknown>>) ?? [];
  const bindings = (c.bindings as Array<Record<string, unknown>>) ?? [];
  const know_artifacts = (c.knowledgeArtifacts as Array<Record<string, unknown>>) ?? [];

  async function addRepo() {
    if (!repo.repoName || !repo.repoUrl) return;
    await runtimeApi.attachRepo(id, repo as never);
    setRepo({ repoName: "", repoUrl: "", defaultBranch: "main", repositoryType: "GITHUB" });
    await mutateCap();
  }

  async function addBinding() {
    if (!bind.agentTemplateId || !bind.bindingName) return;
    await runtimeApi.bindAgent(id, bind as never);
    setBind({ agentTemplateId: "", bindingName: "", roleInCapability: "" });
    await mutateCap();
  }

  async function addKnowledge() {
    if (!know.title || !know.content) return;
    await runtimeApi.addKnowledge(id, know as never);
    setKnow({ artifactType: "ARCHITECTURE_SUMMARY", title: "", content: "", confidence: 0.8 });
    await mutateCap();
  }

  const tmplOptions = (templates?.items ?? []) as Record<string, unknown>[];

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-xl font-bold text-slate-900">{c.name as string}</h1>
          <StatusBadge value={c.status as string} />
        </div>
        {!!c.description && <p className="text-sm text-slate-600 mt-2">{c.description as string}</p>}
        <div className="font-mono text-xs text-slate-400 mt-2">id: {c.id as string}</div>
      </div>

      <div className="flex gap-1 mb-6 border-b border-slate-200">
        {(["bindings", "repos", "knowledge", "code", "sources", "tuning"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors capitalize ${
              tab === t ? "border-singularity-600 text-singularity-700" : "border-transparent text-slate-500 hover:text-slate-800"
            }`}>{t}</button>
        ))}
      </div>

      {tab === "bindings" && (
        <div>
          <div className="card p-4 mb-4 flex gap-2 items-end">
            <div className="flex-1">
              <label className="block text-xs font-medium text-slate-600 mb-1">Agent Template</label>
              <select className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                value={bind.agentTemplateId} onChange={e => setBind(b => ({ ...b, agentTemplateId: e.target.value }))}>
                <option value="">—</option>
                {tmplOptions.map(t => <option key={t.id as string} value={t.id as string}>{t.name as string} ({t.roleType as string})</option>)}
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-slate-600 mb-1">Binding name</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                placeholder="CCRE Architect Agent"
                value={bind.bindingName} onChange={e => setBind(b => ({ ...b, bindingName: e.target.value }))} />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-slate-600 mb-1">Role in capability</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                placeholder="CAPABILITY_ARCHITECT"
                value={bind.roleInCapability} onChange={e => setBind(b => ({ ...b, roleInCapability: e.target.value }))} />
            </div>
            <button className="btn-primary" onClick={addBinding}><Plus size={14} /> Bind</button>
          </div>

          <div className="space-y-2">
            {bindings.map(b => {
              const at = b.agentTemplate as Record<string, unknown>;
              return (
                <div key={b.id as string} className="card p-4 text-sm">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-slate-800">{b.bindingName as string}</span>
                    <StatusBadge value={b.status as string} />
                    <span className="text-xs text-slate-500">{at?.name as string}</span>
                  </div>
                  <div className="font-mono text-xs text-slate-400">id: {b.id as string}</div>
                </div>
              );
            })}
            {bindings.length === 0 && <p className="text-slate-400 text-sm">No bindings yet.</p>}
          </div>
        </div>
      )}

      {tab === "repos" && (
        <div>
          <div className="card p-4 mb-4 flex gap-2 items-end">
            <input className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm"
              placeholder="repo name" value={repo.repoName} onChange={e => setRepo(r => ({ ...r, repoName: e.target.value }))} />
            <input className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm"
              placeholder="https://github.com/org/repo"
              value={repo.repoUrl} onChange={e => setRepo(r => ({ ...r, repoUrl: e.target.value }))} />
            <button className="btn-primary" onClick={addRepo}><Plus size={14} /> Attach</button>
          </div>
          <div className="space-y-2">
            {repos.map(r => (
              <div key={r.id as string} className="card p-4 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-800">{r.repoName as string}</span>
                  <span className="text-xs text-slate-500">{r.defaultBranch as string}</span>
                </div>
                <a href={r.repoUrl as string} className="text-xs text-singularity-600 hover:underline" target="_blank" rel="noreferrer">{r.repoUrl as string}</a>
              </div>
            ))}
            {repos.length === 0 && <p className="text-slate-400 text-sm">No repositories attached.</p>}
          </div>
        </div>
      )}

      {tab === "code" && (
        <div>
          <p className="text-sm text-slate-600 mb-3">
            Pick a local directory; the SPA walks it client-side and sends only the source files. The server extracts top-level symbols (Python / TS / JS), embeds each, and stores them so the prompt-composer can attach a <code>CODE_CONTEXT</code> layer to agent prompts.
          </p>
          {repos.length === 0 && (
            <div className="card p-4 text-sm text-slate-500">
              Attach a repository under the <button className="underline" onClick={() => setTab("repos")}>repos</button> tab first — extracted symbols are scoped to a repository.
            </div>
          )}
          {repos.map(r => (
            <CodeExtractCard
              key={r.id as string}
              capabilityId={id}
              repoId={r.id as string}
              repoName={r.repoName as string}
            />
          ))}
        </div>
      )}

      {tab === "sources" && <SourcesTab capabilityId={id} repos={repos} onMutate={mutateCap} />}

      {tab === "tuning" && <TuningTab capabilityId={id} />}

      {tab === "knowledge" && (
        <div>
          <KnowledgeUploadCard
            capabilityId={id}
            artifactType={know.artifactType}
            onUploaded={async () => { await mutateCap(); }}
          />
          <div className="card p-4 mb-4 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
                placeholder="artifactType (e.g. ARCHITECTURE_SUMMARY)"
                value={know.artifactType} onChange={e => setKnow(k => ({ ...k, artifactType: e.target.value }))} />
              <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
                placeholder="title"
                value={know.title} onChange={e => setKnow(k => ({ ...k, title: e.target.value }))} />
            </div>
            <textarea rows={3} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
              placeholder="content"
              value={know.content} onChange={e => setKnow(k => ({ ...k, content: e.target.value }))} />
            <button className="btn-primary" onClick={addKnowledge}><Plus size={14} /> Add Artifact</button>
          </div>
          <div className="space-y-2">
            {know_artifacts.map(a => (
              <div key={a.id as string} className="card p-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded">{a.artifactType as string}</span>
                  <span className="font-medium text-slate-800 text-sm">{a.title as string}</span>
                </div>
                <p className="text-sm text-slate-600">{a.content as string}</p>
              </div>
            ))}
            {know_artifacts.length === 0 && <p className="text-slate-400 text-sm">No knowledge artifacts.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

// M14 — file-upload variant for knowledge artifacts. v0 reads txt/md
// M15 — multipart upload to the agent-runtime endpoint. Server extracts
// text from txt/md directly and from PDFs via pdf-parse, then delegates to
// addKnowledge for embedding + storage.
const SUPPORTED_EXT = /\.(txt|md|markdown|pdf)$/i;
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB matches the multer limit

function KnowledgeUploadCard({
  capabilityId, artifactType, onUploaded,
}: {
  capabilityId: string;
  artifactType: string;
  onUploaded: () => Promise<void> | void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpload, setLastUpload] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);

  async function handleFiles(files: FileList | File[]) {
    setBusy(true); setError(null);
    const arr = Array.from(files);
    try {
      for (const f of arr) {
        if (!SUPPORTED_EXT.test(f.name)) {
          throw new Error(`Unsupported file type: ${f.name}. Accepts .txt, .md, .pdf.`);
        }
        if (f.size > MAX_BYTES) {
          throw new Error(`File too large: ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB > 25 MB).`);
        }
      }
      const fd = new FormData();
      fd.append("artifactType", artifactType || "DOC");
      for (const f of arr) fd.append("files", f, f.name);

      const res = await fetch(
        `/api/runtime/capabilities/${encodeURIComponent(capabilityId)}/knowledge-artifacts/upload`,
        { method: "POST", body: fd },
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Upload failed (${res.status}): ${detail.slice(0, 200)}`);
      }
      const body = await res.json() as { data?: { uploaded: number; skipped?: Array<{name:string; reason:string}> } };
      const skipped = body.data?.skipped ?? [];
      if (skipped.length > 0) {
        setError(`Skipped ${skipped.length}: ${skipped.map(s => `${s.name} (${s.reason})`).join(", ")}`);
      }
      setLastUpload(arr.map(f => f.name).filter(n => !skipped.some(s => s.name === n)));
      await onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div
      className={`card p-4 mb-3 border-2 border-dashed transition-colors ${dragOver ? "border-singularity-500 bg-singularity-50" : "border-slate-200"}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault(); setDragOver(false);
        if (e.dataTransfer.files) void handleFiles(e.dataTransfer.files);
      }}
    >
      <div className="flex items-center gap-3">
        <Upload size={18} className="text-slate-500 shrink-0" />
        <div className="flex-1">
          <p className="text-sm text-slate-700 font-medium">Upload knowledge files</p>
          <p className="text-xs text-slate-500">
            Drag and drop <code>.txt</code> / <code>.md</code> / <code>.pdf</code> files, or click to browse. Files become ACTIVE artifacts the prompt-composer pulls into <code>RUNTIME_EVIDENCE</code> layers (and now embedded for semantic retrieval).
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf"
          className="hidden"
          onChange={(e) => { if (e.target.files) void handleFiles(e.target.files); }}
        />
        <button
          className="btn-primary text-xs whitespace-nowrap"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "Uploading…" : "Choose files"}
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
      {lastUpload.length > 0 && !error && (
        <div className="mt-2 text-xs text-emerald-700">Uploaded: {lastUpload.join(", ")}</div>
      )}
    </div>
  );
}

// M14 — directory picker → regex symbol extractor → embeddings → DB. Filter
// to source files client-side so we don't ship binaries / images / lockfiles
// over the wire. v0 caps at 25 MB total per request (matches the server's
// express.json limit).
const SOURCE_EXT = /\.(py|ts|tsx|js|jsx|mjs|cjs)$/i;
const CODE_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "__pycache__", ".venv", "venv",
  ".next", ".turbo", ".cache", "coverage", "target",
]);
const FILE_SIZE_CAP = 200_000; // 200 KB per file
const PAYLOAD_CAP   = 24_000_000; // 24 MB total

function CodeExtractCard({
  capabilityId, repoId, repoName,
}: {
  capabilityId: string;
  repoId: string;
  repoName: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    filesProcessed: number; symbolsScanned: number; inserted: number;
    skippedDuplicate: number; embeddingErrors: number;
    provider: string; providerModel: string;
  } | null>(null);

  async function handleFiles(files: FileList) {
    setBusy(true); setError(null); setResult(null);
    try {
      const payload: Array<{ path: string; content: string }> = [];
      let bytes = 0;
      for (const f of Array.from(files)) {
        const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
        if (!SOURCE_EXT.test(path)) continue;
        if (path.split("/").some((seg) => CODE_SKIP_DIRS.has(seg))) continue;
        if (f.size > FILE_SIZE_CAP) continue;
        const text = await f.text();
        bytes += text.length;
        if (bytes > PAYLOAD_CAP) {
          throw new Error(
            `Selection exceeds ${PAYLOAD_CAP / 1_000_000} MB after filtering. Trim the directory or extract in batches.`,
          );
        }
        payload.push({ path, content: text });
      }
      if (payload.length === 0) {
        throw new Error("No source files (.py / .ts / .tsx / .js / .jsx) found in selection.");
      }
      const out = await runtimeApi.extractRepositorySymbols(capabilityId, repoId, payload);
      setResult(out);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Extraction failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="card p-4 mb-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800">{repoName}</p>
          <p className="text-xs text-slate-500">
            v0 extracts top-level symbols (Python <code>def/class</code>, TS/JS <code>function/class/interface/type/enum/const</code>) via regex. Tree-sitter is the v1 upgrade.
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          /* webkitdirectory is non-standard but supported by all major browsers */
          // @ts-ignore - non-standard attr
          webkitdirectory=""
          // @ts-ignore - non-standard attr
          directory=""
          multiple
          className="hidden"
          onChange={(e) => { if (e.target.files) void handleFiles(e.target.files); }}
        />
        <button
          className="btn-primary text-xs whitespace-nowrap"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "Extracting…" : "Pick directory"}
        </button>
      </div>
      {error && <div className="mt-3 text-xs text-red-600">{error}</div>}
      {result && (
        <div className="mt-3 text-xs text-slate-700 grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="Files processed" value={result.filesProcessed} />
          <Stat label="Symbols scanned" value={result.symbolsScanned} />
          <Stat label="Inserted" value={result.inserted} highlight="emerald" />
          <Stat label="Skipped (dup)" value={result.skippedDuplicate} />
          <Stat label="Embedding errors" value={result.embeddingErrors} highlight={result.embeddingErrors > 0 ? "red" : undefined} />
          <Stat label="Provider" value={`${result.provider}:${result.providerModel}`} colSpan={3} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, highlight, colSpan }: { label: string; value: string | number; highlight?: "emerald" | "red"; colSpan?: number }) {
  const colour =
    highlight === "emerald" ? "text-emerald-700" :
    highlight === "red"     ? "text-red-700" :
                              "text-slate-700";
  return (
    <div className={`bg-slate-50 rounded px-2 py-1.5${colSpan ? ` sm:col-span-${colSpan}` : ""}`}>
      <div className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-sm font-medium ${colour} truncate`}>{value}</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// M17 — sources tab. Per-repo poll-interval editor + URL knowledge sources
// (markdown / plain text). Worker re-fetches on cadence; only writes when
// content hash changes.
// ────────────────────────────────────────────────────────────────────────────

function SourcesTab({ capabilityId, repos, onMutate }: {
  capabilityId: string;
  repos: Array<Record<string, unknown>>;
  onMutate: () => Promise<unknown> | void;
}) {
  const { data: sources, mutate: mutateSources } = useSWR(
    `know-sources-${capabilityId}`,
    () => runtimeApi.listKnowledgeSources(capabilityId),
  );
  const list = (sources ?? []) as Array<Record<string, unknown>>;

  const [newUrl, setNewUrl] = useState("");
  const [newInterval, setNewInterval] = useState(600);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addSource() {
    if (!newUrl) return;
    setBusy(true); setError(null);
    try {
      await runtimeApi.addKnowledgeSource(capabilityId, {
        url: newUrl, pollIntervalSec: newInterval,
      });
      setNewUrl(""); setNewInterval(600);
      await mutateSources();
    } catch (err) {
      setError(err instanceof Error ? err.message : "add failed");
    } finally { setBusy(false); }
  }

  async function deleteSource(id: string) {
    await runtimeApi.deleteKnowledgeSource(capabilityId, id);
    await mutateSources();
  }

  return (
    <div className="space-y-6">
      {/* ── Repo polling section ───────────────────────────────────────── */}
      <section>
        <h3 className="text-sm font-semibold text-slate-900 mb-2">Repository polling</h3>
        <p className="text-xs text-slate-500 mb-3">
          Set <code>pollIntervalSec</code> on a repo and the agent-runtime worker re-clones + re-extracts symbols when the remote SHA changes. Leave blank to disable.
        </p>
        {repos.length === 0 && <p className="text-sm text-slate-400">No repositories attached. Add one under the <strong>repos</strong> tab.</p>}
        <div className="space-y-2">
          {repos.map(r => <RepoPollRow key={r.id as string} capabilityId={capabilityId} repo={r} onMutate={onMutate} />)}
        </div>
      </section>

      {/* ── Knowledge URL sources section ──────────────────────────────── */}
      <section>
        <h3 className="text-sm font-semibold text-slate-900 mb-2">Knowledge URL sources</h3>
        <p className="text-xs text-slate-500 mb-3">
          Worker fetches each URL on cadence; when the content hash changes it archives the prior artifact and creates a new one (also embedded for semantic retrieval).
        </p>

        <div className="card p-3 mb-3 flex gap-2 items-end">
          <div className="flex-1">
            <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">URL</label>
            <input
              className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded-md"
              placeholder="https://raw.githubusercontent.com/.../README.md"
              value={newUrl} onChange={e => setNewUrl(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Poll seconds</label>
            <input
              type="number" min={60} max={86400}
              className="w-24 px-2 py-1.5 text-sm border border-slate-200 rounded-md"
              value={newInterval} onChange={e => setNewInterval(Number(e.target.value))}
            />
          </div>
          <button className="btn-primary text-xs" disabled={busy || !newUrl} onClick={addSource}>
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
        {error && <div className="text-xs text-red-600 mb-2">{error}</div>}

        <div className="space-y-2">
          {list.map(s => (
            <div key={s.id as string} className="card p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-800 truncate">{(s.title as string) || (s.url as string)}</div>
                  <div className="text-xs text-slate-500 truncate">{s.url as string}</div>
                  <div className="text-[11px] text-slate-500 mt-1 flex flex-wrap gap-3">
                    <span>poll: every <strong>{s.pollIntervalSec as number}s</strong></span>
                    <span>last: {s.lastPolledAt ? new Date(s.lastPolledAt as string).toLocaleString() : "never"}</span>
                    {s.lastPollError ? <span className="text-red-600">err: {String(s.lastPollError).slice(0,80)}</span> : null}
                  </div>
                </div>
                <button className="text-xs text-red-600 hover:underline" onClick={() => deleteSource(s.id as string)}>Remove</button>
              </div>
            </div>
          ))}
          {list.length === 0 && <p className="text-sm text-slate-400">No knowledge sources yet.</p>}
        </div>
      </section>
    </div>
  );
}

function RepoPollRow({ capabilityId, repo, onMutate }: {
  capabilityId: string;
  repo: Record<string, unknown>;
  onMutate: () => Promise<unknown> | void;
}) {
  const [interval, setInterval] = useState<string>(repo.pollIntervalSec ? String(repo.pollIntervalSec) : "");
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function save() {
    setBusy(true);
    try {
      await runtimeApi.updateRepoPoll(capabilityId, repo.id as string, {
        pollIntervalSec: interval ? Number(interval) : null,
      });
      setSavedAt(Date.now());
      await onMutate();
    } finally { setBusy(false); }
  }

  return (
    <div className="card p-3 flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-800 truncate">{repo.repoName as string}</div>
        <div className="text-xs text-slate-500 truncate">{repo.repoUrl as string}</div>
        <div className="text-[11px] text-slate-500 mt-1 flex flex-wrap gap-3">
          <span>last: {repo.lastPolledAt ? new Date(repo.lastPolledAt as string).toLocaleString() : "never"}</span>
          {repo.lastPolledSha ? <span>sha: <code>{String(repo.lastPolledSha).slice(0,7)}</code></span> : null}
          {repo.lastPollError ? <span className="text-red-600">err: {String(repo.lastPollError).slice(0,80)}</span> : null}
        </div>
      </div>
      <div className="flex items-end gap-2">
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Poll seconds</label>
          <input
            type="number" min={60} max={86400}
            className="w-24 px-2 py-1.5 text-sm border border-slate-200 rounded-md"
            value={interval} onChange={e => setInterval(e.target.value)} placeholder="(off)"
          />
        </div>
        <button className="btn-primary text-xs whitespace-nowrap" disabled={busy} onClick={save}>
          {busy ? "Saving…" : savedAt && Date.now() - savedAt < 2000 ? "Saved" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// M17 — tuning tab. Calls composer's debug-retrieval endpoint with a sample
// task and shows scored hits per kind so the operator can sanity-check
// which knowledge / memory / code symbols a real compose would surface.
// ────────────────────────────────────────────────────────────────────────────

// Proxied via next.config: /api/composer/* → composer's /api/v1/*
const COMPOSER_DEBUG_URL = "/api/composer/compose-and-respond/debug-retrieval";

interface DebugHit {
  cosineSimilarity: number;
  ageDays: number;
  finalScore: number;
}
interface DebugResponse {
  capabilityId: string;
  task: string;
  provider: string;
  model: string;
  dim: number;
  tuning: { recencyBoostMax: number; recencyBoostDays: number };
  knowledge: Array<DebugHit & { id: string; artifactType: string; title: string; content: string }>;
  memory:    Array<DebugHit & { id: string; memoryType: string; title: string; content: string }>;
  code:      Array<DebugHit & { symbol_id: string; symbolName: string | null; symbolType: string | null;
                                filePath: string; startLine: number | null; summary: string | null;
                                language: string | null; repoName: string }>;
}

function TuningTab({ capabilityId }: { capabilityId: string }) {
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<DebugResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!task.trim()) return;
    setBusy(true); setError(null); setData(null);
    try {
      const res = await fetch(COMPOSER_DEBUG_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capabilityId, task }),
      });
      if (!res.ok) throw new Error(`debug ${res.status}: ${(await res.text()).slice(0, 200)}`);
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 mb-1">Retrieval tuning</h3>
        <p className="text-xs text-slate-500">
          Enter a sample task; we'll embed it and run the same hybrid retrieval (cosine × recency boost) the prompt-composer uses, then show scored hits per kind.
          Recency boost is configured via <code>EMBEDDING_RECENCY_BOOST</code> / <code>EMBEDDING_RECENCY_DAYS</code> on the composer container.
        </p>
      </div>
      <div className="card p-3 flex gap-2">
        <input
          className="flex-1 px-2 py-1.5 text-sm border border-slate-200 rounded-md"
          placeholder="How do I price a bond?"
          value={task} onChange={e => setTask(e.target.value)}
        />
        <button className="btn-primary text-xs" disabled={busy || !task.trim()} onClick={run}>
          {busy ? "Scoring…" : "Run"}
        </button>
      </div>
      {error && <div className="text-xs text-red-600">{error}</div>}
      {data && (
        <div className="space-y-3">
          <div className="text-xs text-slate-500">
            provider: <strong>{data.provider}</strong> · model: <strong>{data.model}</strong> · dim: <strong>{data.dim}</strong>
            {" "}· recency boost ≤ <strong>{(data.tuning.recencyBoostMax * 100).toFixed(0)}%</strong> for items &lt; <strong>{data.tuning.recencyBoostDays}d</strong> old
          </div>
          <ScoredSection title="Knowledge" hits={data.knowledge.map(h => ({ ...h, label: h.title, sub: h.artifactType }))} />
          <ScoredSection title="Memory"    hits={data.memory.map(h => ({ ...h, label: h.title, sub: h.memoryType }))} />
          <ScoredSection title="Code"      hits={data.code.map(h => ({
            ...h,
            label: `${h.symbolName ?? "?"} (${h.symbolType ?? "?"})`,
            sub:   `${h.repoName}/${h.filePath}:${h.startLine ?? "?"}`,
          }))} />
        </div>
      )}
    </div>
  );
}

function ScoredSection({ title, hits }: {
  title: string;
  hits: Array<{ label: string; sub: string; cosineSimilarity: number; ageDays: number; finalScore: number }>;
}) {
  return (
    <div className="card p-3">
      <h4 className="text-xs font-semibold text-slate-700 mb-2">{title} ({hits.length})</h4>
      {hits.length === 0 ? (
        <p className="text-xs text-slate-400">No hits.</p>
      ) : (
        <div className="space-y-1.5">
          {hits.map((h, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className="text-slate-400 w-6 shrink-0">#{i + 1}</span>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-slate-800 truncate">{h.label}</div>
                <div className="text-slate-500 truncate">{h.sub}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-slate-700">cos <strong>{h.cosineSimilarity.toFixed(3)}</strong></div>
                <div className="text-slate-500">age {h.ageDays.toFixed(1)}d → score <strong>{h.finalScore.toFixed(3)}</strong></div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
