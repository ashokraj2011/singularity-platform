import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * M42.6 — Approval UI shell.
 *
 * Single-operator, single-run cockpit. Left rail: runs list with filter
 * by greenfield/brownfield/all. Right pane: run detail with tabs for
 * Overview, Files, Gaps, LLM Tasks, Receipt. Brownfield tab adds a
 * "Change Plan" view alongside Files.
 *
 * State is intentionally local — no router, no global store; refresh
 * just re-fetches. Multi-tenancy / presence / lock is out of scope for
 * V1 (M43+).
 */
import { useEffect, useState } from 'react';
import { api } from './lib/api';
import { RunList } from './components/RunList';
import { RunDetail } from './components/RunDetail';
export function App() {
    const [runs, setRuns] = useState(null);
    const [error, setError] = useState(null);
    const [filter, setFilter] = useState('ALL');
    const [selectedRunId, setSelectedRunId] = useState(null);
    const [refreshKey, setRefreshKey] = useState(0);
    useEffect(() => {
        let cancelled = false;
        setRuns(null);
        api.listRuns({ take: 50, mode: filter === 'ALL' ? undefined : filter })
            .then((r) => { if (!cancelled) {
            setRuns(r.items);
            setError(null);
        } })
            .catch((err) => { if (!cancelled)
            setError(err.message); });
        return () => { cancelled = true; };
    }, [filter, refreshKey]);
    return (_jsxs("div", { className: "app", children: [_jsxs("aside", { className: "sidebar", children: [_jsxs("header", { children: [_jsx("img", { src: "/foundry-mark.svg", alt: "", width: 24, height: 24 }), _jsx("h1", { children: "Code Foundry" }), _jsx("button", { onClick: () => setRefreshKey(k => k + 1), style: { marginLeft: 'auto', padding: '3px 9px', fontSize: 11 }, title: "Reload runs", children: "\u21BB" })] }), _jsx("div", { className: "filters", children: ['ALL', 'GREENFIELD', 'BROWNFIELD'].map(f => (_jsx("button", { className: filter === f ? 'active' : '', onClick: () => setFilter(f), children: f.toLowerCase() }, f))) }), _jsx(RunList, { runs: runs, error: error, selectedId: selectedRunId, onSelect: setSelectedRunId })] }), _jsx("main", { className: "detail", children: selectedRunId ? (_jsx(RunDetail, { runId: selectedRunId, onChanged: () => setRefreshKey(k => k + 1) })) : (_jsx("div", { className: "empty", style: { paddingTop: 80 }, children: "Pick a run from the left to inspect it." })) })] }));
}
