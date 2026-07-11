import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const page = fs.readFileSync(path.join(process.cwd(), "src/app/capabilities/[id]/page.tsx"), "utf8");

assert.match(
  page,
  /const mutationActionInFlightRef = useRef\(false\);[\s\S]*?const archiveInFlightRef = useRef\(false\);[\s\S]*?const \[mutationAction, setMutationAction\] = useState<"repo" \| "repo-delete" \| "binding" \| "binding-delete" \| "knowledge" \| "knowledge-delete" \| null>\(null\);[\s\S]*?const \[mutationMsg, setMutationMsg\][\s\S]*?const \[mutationError, setMutationError\]/,
  "capability detail should track controlled feedback for small mutation actions",
);

assert.match(
  page,
  /async function addRepo\(\)[\s\S]*?if \(mutationActionInFlightRef\.current\) return;[\s\S]*?mutationActionInFlightRef\.current = true;[\s\S]*?setMutationAction\("repo"\);[\s\S]*?runtimeApi\.attachRepo\(id, repo as never\)[\s\S]*?setMutationMsg\("Repository source attached[\s\S]*?catch \(err\) \{[\s\S]*?setMutationError\(actionErrorMessage\(err, "Attach repository failed"\)\);[\s\S]*?mutationActionInFlightRef\.current = false;/,
  "repository attach should catch API errors and render controlled feedback",
);

assert.match(
  page,
  /async function addBinding\(\)[\s\S]*?if \(mutationActionInFlightRef\.current\) return;[\s\S]*?mutationActionInFlightRef\.current = true;[\s\S]*?setMutationAction\("binding"\);[\s\S]*?runtimeApi\.bindAgent\(id,[\s\S]*?setMutationMsg\("Agent binding added to this capability\."\);[\s\S]*?catch \(err\) \{[\s\S]*?setMutationError\(actionErrorMessage\(err, "Bind agent failed"\)\);[\s\S]*?mutationActionInFlightRef\.current = false;/,
  "agent binding should catch API errors and render controlled feedback",
);

assert.match(
  page,
  /async function addKnowledge\(\)[\s\S]*?if \(mutationActionInFlightRef\.current\) return;[\s\S]*?mutationActionInFlightRef\.current = true;[\s\S]*?setMutationAction\("knowledge"\);[\s\S]*?runtimeApi\.addKnowledge\(id, know as never\)[\s\S]*?setMutationMsg\("Knowledge artifact added to this capability\."\);[\s\S]*?catch \(err\) \{[\s\S]*?setMutationError\(actionErrorMessage\(err, "Add knowledge artifact failed"\)\);[\s\S]*?mutationActionInFlightRef\.current = false;/,
  "knowledge artifact creation should catch API errors and render controlled feedback",
);

assert.match(
  page,
  /async function archiveCapability\(\) \{[\s\S]*?if \(archiveInFlightRef\.current\) return;[\s\S]*?archiveInFlightRef\.current = true;[\s\S]*?if \(!confirmed\) \{[\s\S]*?archiveInFlightRef\.current = false;[\s\S]*?return;[\s\S]*?runtimeApi\.archiveCapability\(id\);[\s\S]*?catch \(err\) \{[\s\S]*?setArchiveError\(err instanceof Error \? err\.message : "Archive failed"\);[\s\S]*?archiveInFlightRef\.current = false;/,
  "archive should use an immediate in-flight guard and release it on cancel, success, or failure",
);

assert.match(
  page,
  /const editSaveInFlightRef = useRef\(false\);[\s\S]*?async function saveCapabilityDetails\(e: React\.FormEvent\) \{[\s\S]*?if \(editSaveInFlightRef\.current\) return;[\s\S]*?if \(!editForm\.name\.trim\(\)\) \{[\s\S]*?setEditError\("Capability name is required\."\);[\s\S]*?return;[\s\S]*?editSaveInFlightRef\.current = true;[\s\S]*?runtimeApi\.updateCapability\(id,[\s\S]*?catch \(err\) \{[\s\S]*?setEditError\(actionErrorMessage\(err, "Capability update failed"\)\);[\s\S]*?editSaveInFlightRef\.current = false;/,
  "capability detail save should single-flight only after validation passes and render normalized errors",
);

assert.match(
  page,
  /function UltraModePanel[\s\S]*?const launchInFlightRef = useRef\(false\);[\s\S]*?async function launchUltraMode\(event: React\.FormEvent\) \{[\s\S]*?if \(launchInFlightRef\.current\) return;[\s\S]*?const goal = form\.goal\.trim\(\);[\s\S]*?if \(!goal\) \{[\s\S]*?return;[\s\S]*?launchInFlightRef\.current = true;[\s\S]*?workgraphApi\.createWorkflowTemplate[\s\S]*?workgraphApi\.launchWorkflowRun[\s\S]*?catch \(err\) \{[\s\S]*?setError\(actionErrorMessage\(err, "Ultra Mode launch failed"\)\);[\s\S]*?launchInFlightRef\.current = false;/,
  "Ultra Mode launch should single-flight after validation and render normalized errors",
);

assert.match(
  page,
  /\{mutationError && <div className="mt-3 text-sm text-red-600">\{mutationError\}<\/div>\}[\s\S]*?\{mutationMsg && <div className="mt-3 text-sm text-emerald-700">\{mutationMsg\}<\/div>\}/,
  "capability detail should render mutation success and error feedback near the action surface",
);

assert.match(
  page,
  /function actionErrorMessage\(err: unknown, fallback: string\): string \{[\s\S]*?err instanceof ApiError && err\.status === 409[\s\S]*?return err\.message[\s\S]*?return fallback;/,
  "action errors should preserve typed conflict messages and fall back safely",
);

assert.match(
  page,
  /function RepoPollRow[\s\S]*?const saveInFlightRef = useRef\(false\);[\s\S]*?const \[error, setError\] = useState<string \| null>\(null\);[\s\S]*?async function save\(\) \{[\s\S]*?if \(!repoId \|\| saveInFlightRef\.current \|\| disabled\) return;[\s\S]*?saveInFlightRef\.current = true;[\s\S]*?setError\(null\);[\s\S]*?runtimeApi\.updateRepoPoll[\s\S]*?catch \(err\) \{[\s\S]*?setSavedAt\(null\);[\s\S]*?setError\(actionErrorMessage\(err, "Repository polling update failed"\)\);[\s\S]*?saveInFlightRef\.current = false;[\s\S]*?\{error && <div className="mt-2 text-xs text-red-600">\{error\}<\/div>\}/,
  "repository poll saves should render row-local errors instead of throwing",
);

assert.match(
  page,
  /value=\{interval\} onChange=\{e => setInterval\(e\.target\.value\)\} placeholder="\(off\)"[\s\S]*?disabled=\{busy \|\| disabled\}/,
  "repository poll interval input should freeze while the row save is running",
);

assert.match(
  page,
  /function KnowledgeUploadCard[\s\S]*?disabled\?: boolean;[\s\S]*?const uploadInFlightRef = useRef\(false\);[\s\S]*?async function handleFiles\(files: FileList \| File\[\]\) \{[\s\S]*?if \(uploadInFlightRef\.current \|\| disabled\) return;[\s\S]*?uploadInFlightRef\.current = true;[\s\S]*?fetch\([\s\S]*?knowledge-artifacts\/upload[\s\S]*?catch \(err\) \{[\s\S]*?setError\(actionErrorMessage\(err, "Upload failed"\)\);[\s\S]*?uploadInFlightRef\.current = false;/,
  "knowledge file upload should use an immediate in-flight/archive guard and normalized error feedback",
);

assert.match(
  page,
  /<KnowledgeUploadCard[\s\S]*?disabled=\{isArchived\}[\s\S]*?Archived capabilities are read-only[\s\S]*?disabled=\{busy \|\| disabled\}/,
  "archived capability detail should render knowledge upload as read-only evidence instead of accepting new files",
);

assert.match(
  page,
  /function CodeExtractCard[\s\S]*?const codeSyncInFlightRef = useRef\(false\);[\s\S]*?async function syncRemoteRepo\(\) \{[\s\S]*?if \(codeSyncInFlightRef\.current \|\| disabled\) return;[\s\S]*?codeSyncInFlightRef\.current = true;[\s\S]*?const out = asObject\(await runtimeApi\.syncCapability\(capabilityId, \{ repositoryIds: \[repoId\] \}\)\);[\s\S]*?catch \(err\) \{[\s\S]*?setError\(actionErrorMessage\(err, "Sync failed"\)\);[\s\S]*?codeSyncInFlightRef\.current = false;/,
  "remote code sync should use an immediate in-flight guard and normalized error feedback",
);

assert.match(
  page,
  /async function handleFiles\(files: FileList\) \{[\s\S]*?if \(codeSyncInFlightRef\.current \|\| disabled\) return;[\s\S]*?codeSyncInFlightRef\.current = true;[\s\S]*?const out = asObject\(await runtimeApi\.syncCapability\(capabilityId, \{ localFiles: payload \}\)\);[\s\S]*?catch \(err\) \{[\s\S]*?setError\(actionErrorMessage\(err, "Extraction failed"\)\);[\s\S]*?codeSyncInFlightRef\.current = false;/,
  "local code extraction should share the code sync in-flight guard and normalized error feedback",
);

assert.match(
  page,
  /type CodeExtractResult = \{[\s\S]*?filesProcessed: number;[\s\S]*?providerModel: string;[\s\S]*?function normalizeCodeExtractResult\(value: unknown\): CodeExtractResult \| null \{[\s\S]*?const record = asRecord\(value\);[\s\S]*?filesProcessed: capabilityNumber\(record\.filesProcessed, 0\),[\s\S]*?embeddingErrors: capabilityNumber\(record\.embeddingErrors, 0\),[\s\S]*?provider: capabilityString\(record\.provider\) \|\| "unknown",[\s\S]*?providerModel: capabilityString\(record\.providerModel\) \|\| "unknown"/,
  "code extraction result stats should be normalized before rendering",
);

assert.match(
  page,
  /const out = asObject\(await runtimeApi\.syncCapability\(capabilityId, \{ repositoryIds: \[repoId\] \}\)\);[\s\S]*?setSyncSummary\(out\);[\s\S]*?const out = asObject\(await runtimeApi\.syncCapability\(capabilityId, \{ localFiles: payload \}\)\);[\s\S]*?const local = normalizeCodeExtractResult\(out\.local\);/,
  "code sync summaries should tolerate malformed API responses and local stats should not be blindly cast",
);

assert.match(
  page,
  /function SourcesTab[\s\S]*?const sourceActionInFlightRef = useRef\(false\);[\s\S]*?const \[deleteBusyId, setDeleteBusyId\] = useState<string \| null>\(null\);[\s\S]*?const \[msg, setMsg\] = useState<string \| null>\(null\);[\s\S]*?async function addSource\(\) \{[\s\S]*?if \(sourceActionInFlightRef\.current\) return;[\s\S]*?sourceActionInFlightRef\.current = true;[\s\S]*?runtimeApi\.addKnowledgeSource\(capabilityId,[\s\S]*?setMsg\("Knowledge URL source added\.[\s\S]*?sourceActionInFlightRef\.current = false;[\s\S]*?async function deleteSource\(id: string\) \{[\s\S]*?if \(!id \|\| sourceActionInFlightRef\.current\) return;[\s\S]*?sourceActionInFlightRef\.current = true;[\s\S]*?setDeleteBusyId\(id\);[\s\S]*?runtimeApi\.deleteKnowledgeSource\(capabilityId, id\);[\s\S]*?await mutateSources\(\);[\s\S]*?await onMutate\(\);[\s\S]*?setMsg\("Knowledge URL source removed\."\);[\s\S]*?catch \(err\) \{[\s\S]*?setError\(actionErrorMessage\(err, "Remove knowledge URL source failed"\)\);[\s\S]*?sourceActionInFlightRef\.current = false;[\s\S]*?setDeleteBusyId\(null\);/,
  "knowledge URL source removal should catch API errors, prevent duplicate clicks, and refresh capability state",
);

assert.match(
  page,
  /\{msg && <div className="text-xs text-emerald-700 mb-2">\{msg\}<\/div>\}[\s\S]*?disabled=\{disabled \|\| !sourceId \|\| deleteBusyId !== null\}[\s\S]*?\{deleteBusyId === sourceId \? "Removing\.\.\." : "Remove"\}/,
  "knowledge URL source mutations should render controlled success feedback and row busy state",
);

assert.match(
  page,
  /function BootstrapTab[\s\S]*?const actionInFlightRef = useRef\(false\);[\s\S]*?const \[msg, setMsg\] = useState<string \| null>\(null\);[\s\S]*?const actionBusy = busy \|\| syncing;[\s\S]*?async function submitReview\(\) \{[\s\S]*?if \(actionInFlightRef\.current\) return;[\s\S]*?actionInFlightRef\.current = true;[\s\S]*?setBusy\(true\); setError\(null\); setMsg\(null\);[\s\S]*?runtimeApi\.reviewBootstrapRun\(capabilityId, activeRunId,[\s\S]*?setMsg\("Bootstrap review applied\.[\s\S]*?catch \(err\) \{[\s\S]*?setError\(actionErrorMessage\(err, "Bootstrap review failed"\)\);[\s\S]*?actionInFlightRef\.current = false;/,
  "bootstrap review should be single-flight, catch API errors, and render success feedback",
);

assert.match(
  page,
  /async function syncApprovedSources\(\) \{[\s\S]*?if \(actionInFlightRef\.current\) return;[\s\S]*?actionInFlightRef\.current = true;[\s\S]*?setSyncing\(true\); setError\(null\); setMsg\(null\); setSyncResult\(null\);[\s\S]*?runtimeApi\.syncCapability\(capabilityId, \{ repositoryIds, knowledgeSourceIds \}\);[\s\S]*?setMsg\("Approved sources ingested\.[\s\S]*?catch \(err\) \{[\s\S]*?setError\(actionErrorMessage\(err, "Approved source ingestion failed"\)\);[\s\S]*?actionInFlightRef\.current = false;/,
  "bootstrap source ingestion should share the single-flight guard and render controlled feedback",
);

assert.match(
  page,
  /\{msg && <div className="text-sm text-emerald-700">\{msg\}<\/div>\}[\s\S]*?disabled=\{actionBusy \|\| agent\.status === "ACTIVE" \|\| agent\.activationRequired\}[\s\S]*?disabled=\{actionBusy\}[\s\S]*?disabled=\{actionBusy \|\| disabled\} onClick=\{syncApprovedSources\}[\s\S]*?disabled=\{actionBusy \|\| disabled\} onClick=\{submitReview\}/,
  "bootstrap controls should freeze review decisions, agent activation, and both action buttons while one action is running",
);

console.log("capability mutation error handling contract tests passed");
