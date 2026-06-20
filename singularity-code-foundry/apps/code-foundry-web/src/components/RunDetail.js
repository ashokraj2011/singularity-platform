import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * M42.6 — Run detail (tabbed) view.
 *
 * Tabs:
 *   Overview     run header, counts strip, spec/IR hashes, brownfield
 *                impact summary (when mode=BROWNFIELD).
 *   Files        artifact tree + read-only file viewer (Markdown
 *                renderer reused via the artifact reader pattern).
 *   Gaps         CodegenGap rows with severity + region anchor.
 *   LLM Tasks    LlmPatchTask list, click → task pane with dispatch /
 *                apply-patch affordance and a diff viewer.
 *   Receipt      Pretty-print the receipt JSON. The header also shows
 *                a copyable receiptHash.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { OverviewTab } from './tabs/OverviewTab';
import { FilesTab } from './tabs/FilesTab';
import { GapsTab } from './tabs/GapsTab';
import { TasksTab } from './tabs/TasksTab';
import { ReceiptTab } from './tabs/ReceiptTab';
export function RunDetail({ runId, onChanged }) {
    const [run, setRun] = useState(null);
    const [error, setError] = useState(null);
    const [tab, setTab] = useState('overview');
    const [version, setVersion] = useState(0);
    useEffect(() => {
        let cancelled = false;
        setRun(null);
        setError(null);
        api.getRun(runId)
            .then(r => { if (!cancelled)
            setRun(r); })
            .catch(err => { if (!cancelled)
            setError(err.message); });
        return () => { cancelled = true; };
    }, [runId, version]);
    if (error)
        return _jsxs("div", { className: "empty", children: ["Error: ", error] });
    if (!run)
        return _jsx("div", { className: "empty", children: "Loading run\u2026" });
    const refresh = () => { setVersion(v => v + 1); onChanged(); };
    return (_jsxs(_Fragment, { children: [_jsxs("header", { className: "run-header", children: [_jsxs("div", { className: "row-1", children: [_jsx("span", { className: `mode-pill ${run.mode.toLowerCase()}`, children: run.mode }), _jsx("span", { children: run.specName ?? run.specId.slice(0, 8) }), _jsxs("span", { style: { color: 'var(--text-dim)' }, children: ["@", run.specVersion ?? '—'] }), _jsx("span", { className: `status-pill ${classify(run.status)}`, children: run.status })] }), _jsxs("div", { className: "hashes", children: [_jsxs("span", { children: ["runId: ", _jsx("code", { children: run.id })] }), run.spec?.specHash && _jsxs("span", { children: ["specHash: ", _jsx("code", { children: short(run.spec.specHash) })] }), run.spec?.irHash && _jsxs("span", { children: ["irHash: ", _jsx("code", { children: short(run.spec.irHash) })] }), run.receipt?.receiptHash && _jsxs("span", { children: ["receiptHash: ", _jsx("code", { children: short(run.receipt.receiptHash) })] }), run.changePlan?.planHash && _jsxs("span", { children: ["planHash: ", _jsx("code", { children: short(run.changePlan.planHash) })] })] })] }), _jsx("div", { className: "tabs", children: ['overview', 'files', 'gaps', 'tasks', 'receipt'].map(t => (_jsxs("button", { className: tab === t ? 'active' : '', onClick: () => setTab(t), children: [labelFor(t), t === 'gaps' && run.counts.openGaps > 0 ? ` (${run.counts.openGaps})` : null, t === 'tasks' && run.counts.openLlmTasks > 0 ? ` (${run.counts.openLlmTasks})` : null] }, t))) }), _jsxs("div", { className: "tab-body", children: [_jsxs("div", { className: "counts", children: [_jsxs("span", { children: [_jsx("strong", { children: run.counts.artifacts }), " artifacts"] }), _jsxs("span", { children: [_jsx("strong", { children: run.counts.gaps }), " gaps (", run.counts.openGaps, " open)"] }), _jsxs("span", { children: [_jsx("strong", { children: run.counts.llmTasks }), " LLM tasks (", run.counts.openLlmTasks, " open)"] })] }), tab === 'overview' && _jsx(OverviewTab, { run: run }), tab === 'files' && _jsx(FilesTab, { runId: run.id }), tab === 'gaps' && _jsx(GapsTab, { runId: run.id }), tab === 'tasks' && _jsx(TasksTab, { runId: run.id, onChanged: refresh }), tab === 'receipt' && _jsx(ReceiptTab, { runId: run.id })] })] }));
}
function classify(status) {
    if (['COMPLETED', 'CERTIFIED', 'VERIFIED', 'PATCHED'].includes(status))
        return 'good';
    if (['FAILED'].includes(status))
        return 'bad';
    if (['GAPS_DETECTED', 'STARTED', 'GENERATED'].includes(status))
        return 'warn';
    return '';
}
function short(hash) {
    return hash.length > 20 ? `${hash.slice(0, 14)}…${hash.slice(-4)}` : hash;
}
function labelFor(t) {
    switch (t) {
        case 'overview': return 'Overview';
        case 'files': return 'Files';
        case 'gaps': return 'Gaps';
        case 'tasks': return 'LLM Tasks';
        case 'receipt': return 'Receipt';
    }
}
