import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * M42.6 — LLM Patch Tasks tab + approve/reject panel.
 *
 *   - Lists all CodegenLlmPatchTask rows for the run.
 *   - Selecting a task opens a side pane with task metadata, the
 *     dispatch affordance, a diff text area, and the apply-patch
 *     button.
 *   - Dispatch calls /llm-tasks/:id/dispatch which routes through
 *     prompt-composer. The returned diff prefills the text area;
 *     the operator can edit it before applying.
 *   - Apply-patch returns either GUARD_PASSED (panel turns green +
 *     refreshes the run) or GUARD_REJECTED (panel turns red and shows
 *     the stage + reason).
 */
import { useEffect, useMemo, useState } from 'react';
import ReactDiffViewer from 'react-diff-viewer-continued';
import { api } from '../../lib/api';
export function TasksTab({ runId, onChanged }) {
    const [tasks, setTasks] = useState(null);
    const [activeId, setActiveId] = useState(null);
    const [err, setErr] = useState(null);
    const [refreshKey, setRefreshKey] = useState(0);
    useEffect(() => {
        let cancelled = false;
        api.listLlmTasks(runId)
            .then(r => {
            if (cancelled)
                return;
            setTasks(r.items);
            if (r.items.length > 0 && !activeId)
                setActiveId(r.items[0].id);
        })
            .catch(e => { if (!cancelled)
            setErr(e.message); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [runId, refreshKey]);
    const active = useMemo(() => tasks?.find(t => t.id === activeId) ?? null, [tasks, activeId]);
    if (err)
        return _jsx("div", { className: "empty", children: err });
    if (!tasks)
        return _jsx("div", { className: "empty", children: "Loading tasks\u2026" });
    if (tasks.length === 0)
        return _jsx("div", { className: "empty", children: "No LLM patch tasks for this run." });
    return (_jsxs("div", { style: { display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16 }, children: [_jsxs("div", { className: "panel", style: { padding: 0 }, children: [_jsx("h2", { style: { padding: '12px 16px 0' }, children: "Tasks" }), _jsx("table", { children: _jsx("tbody", { children: tasks.map(t => (_jsxs("tr", { className: "clickable", onClick: () => setActiveId(t.id), style: activeId === t.id ? { background: 'var(--accent-soft)' } : undefined, children: [_jsxs("td", { children: [_jsx("div", { style: { fontSize: 12 }, children: t.taskType }), _jsxs("div", { style: { fontSize: 10, color: 'var(--text-dim)' }, children: [t.targetFile.split('/').pop(), " \u2022 ", t.regionId] })] }), _jsx("td", { children: _jsx("span", { className: `status-pill ${taskClass(t.status)}`, children: t.status }) })] }, t.id))) }) })] }), active && (_jsx(TaskPane, { task: active, onApplied: () => {
                    setRefreshKey(k => k + 1);
                    onChanged();
                } }))] }));
}
function TaskPane({ task, onApplied }) {
    const [diff, setDiff] = useState('');
    const [dispatchErr, setDispatchErr] = useState(null);
    const [applyResult, setApplyResult] = useState(null);
    const [busy, setBusy] = useState(null);
    async function onDispatch() {
        setBusy('dispatch');
        setDispatchErr(null);
        try {
            const r = await api.dispatchTask(task.id);
            if (r.status === 'OK' && r.diff)
                setDiff(r.diff);
            else if (r.error)
                setDispatchErr(`${r.status}: ${r.error}`);
            else
                setDispatchErr(`${r.status}: no diff returned.`);
        }
        catch (err) {
            setDispatchErr(err.message);
        }
        finally {
            setBusy(null);
        }
    }
    async function onApply() {
        if (!diff.trim())
            return;
        setBusy('apply');
        setApplyResult(null);
        try {
            const r = await api.applyPatch(task.id, diff);
            setApplyResult(r);
            if (r.status === 'GUARD_PASSED')
                onApplied();
        }
        catch (err) {
            setApplyResult({ status: 'GUARD_REJECTED', stage: 'transport', reason: err.message });
        }
        finally {
            setBusy(null);
        }
    }
    const meta = task.metadata;
    const isResolved = task.status === 'GUARD_PASSED';
    return (_jsxs("div", { className: "panel", style: { overflow: 'hidden' }, children: [_jsx("h2", { children: "Task" }), _jsx("table", { children: _jsxs("tbody", { children: [_jsxs("tr", { children: [_jsx("th", { children: "Type" }), _jsx("td", { children: _jsx("code", { children: task.taskType }) })] }), _jsxs("tr", { children: [_jsx("th", { children: "Status" }), _jsx("td", { children: _jsx("span", { className: `status-pill ${taskClass(task.status)}`, children: task.status }) })] }), _jsxs("tr", { children: [_jsx("th", { children: "Target file" }), _jsx("td", { children: _jsx("code", { children: task.targetFile }) })] }), task.targetClass && _jsxs("tr", { children: [_jsx("th", { children: "Class" }), _jsx("td", { children: _jsx("code", { children: task.targetClass }) })] }), task.targetMethod && _jsxs("tr", { children: [_jsx("th", { children: "Method" }), _jsx("td", { children: _jsx("code", { children: task.targetMethod }) })] }), _jsxs("tr", { children: [_jsx("th", { children: "Region" }), _jsx("td", { children: task.regionId })] }), _jsxs("tr", { children: [_jsx("th", { children: "Allowed" }), _jsx("td", { children: _jsx("code", { children: JSON.stringify(task.allowedChanges) }) })] }), _jsxs("tr", { children: [_jsx("th", { children: "Forbidden" }), _jsx("td", { children: _jsx("code", { children: JSON.stringify(task.forbiddenChanges) }) })] })] }) }), meta && Object.keys(meta).length > 0 ? (_jsxs("details", { style: { marginTop: 10 }, children: [_jsx("summary", { style: { cursor: 'pointer', fontSize: 12, color: 'var(--text-dim)' }, children: "Metadata" }), _jsx("pre", { style: { marginTop: 8, padding: 10, background: 'var(--code-bg)', borderRadius: 4, overflow: 'auto', maxHeight: 200 }, children: JSON.stringify(meta, null, 2) })] })) : null, _jsxs("div", { style: { marginTop: 16, display: 'flex', gap: 8 }, children: [_jsx("button", { onClick: onDispatch, disabled: busy !== null || isResolved, children: busy === 'dispatch' ? 'Dispatching…' : 'Dispatch (LLM)' }), _jsx("button", { className: "primary", onClick: onApply, disabled: busy !== null || !diff.trim() || isResolved, children: busy === 'apply' ? 'Applying…' : 'Apply patch' })] }), dispatchErr && _jsxs("div", { className: "banner warn", style: { marginTop: 12 }, children: ["Dispatch: ", dispatchErr] }), applyResult && applyResult.status === 'GUARD_PASSED' && (_jsxs("div", { className: "banner good", style: { marginTop: 12 }, children: ["\u2713 Patch accepted. ", applyResult.appliedFiles?.length ?? 0, " file(s) written."] })), applyResult && applyResult.status === 'GUARD_REJECTED' && (_jsxs("div", { className: "banner bad", style: { marginTop: 12 }, children: ["\u2717 Patch Guard rejected at ", _jsx("code", { children: applyResult.stage }), ": ", applyResult.reason] })), _jsxs("div", { style: { marginTop: 14 }, children: [_jsx("div", { style: { fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }, children: "Unified diff" }), _jsx("textarea", { rows: 10, value: diff, onChange: (e) => setDiff(e.target.value), disabled: isResolved, placeholder: "Paste a unified diff here, or click Dispatch (LLM) to fetch one.", style: { width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 } }), diff.trim() && (_jsx("div", { className: "diff-wrap", children: _jsx(ReactDiffViewer, { oldValue: extractOld(diff), newValue: extractNew(diff), splitView: false, useDarkTheme: true, hideLineNumbers: true }) }))] })] }));
}
function taskClass(status) {
    if (status === 'GUARD_PASSED')
        return 'good';
    if (status === 'GUARD_REJECTED' || status === 'FAILED')
        return 'bad';
    if (status === 'PENDING' || status === 'DISPATCHED')
        return 'warn';
    return '';
}
// Very rough split — the React diff viewer wants old/new strings to
// render side-by-side. We approximate by stripping the +/- prefixes
// and showing the unified body as both sides; the textarea still has
// the canonical text and that's what gets POSTed to apply-patch.
function extractOld(diff) {
    return diff.split(/\r?\n/).filter(l => !l.startsWith('+++') && !l.startsWith('+'))
        .map(l => l.startsWith('-') && !l.startsWith('---') ? l.slice(1) : l).join('\n');
}
function extractNew(diff) {
    return diff.split(/\r?\n/).filter(l => !l.startsWith('---') && !l.startsWith('-'))
        .map(l => l.startsWith('+') && !l.startsWith('+++') ? l.slice(1) : l).join('\n');
}
