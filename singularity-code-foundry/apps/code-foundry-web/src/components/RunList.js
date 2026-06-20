import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
export function RunList({ runs, error, selectedId, onSelect }) {
    if (error) {
        return _jsxs("div", { className: "empty", children: ["Error loading runs: ", error] });
    }
    if (runs === null) {
        return _jsx("div", { className: "empty", children: "Loading\u2026" });
    }
    if (runs.length === 0) {
        return _jsx("div", { className: "empty", children: "No runs yet. Generate one via the CLI or REST." });
    }
    return (_jsx("ul", { className: "run-list", children: runs.map(r => (_jsxs("li", { className: `run-row${selectedId === r.id ? ' active' : ''}`, onClick: () => onSelect(r.id), children: [_jsxs("div", { className: "row-head", children: [_jsxs("span", { title: r.specName ?? r.specId, children: [r.specName ?? r.specId.slice(0, 8), r.specVersion ? _jsxs("span", { style: { color: 'var(--text-dim)' }, children: [" @", r.specVersion] }) : null] }), _jsx("span", { className: `mode-pill ${r.mode.toLowerCase()}`, children: r.mode === 'GREENFIELD' ? 'G' : 'B' })] }), _jsxs("div", { className: "row-meta", children: [_jsx("span", { className: `status-pill ${classify(r.status)}`, children: r.status }), _jsx("span", { children: formatDate(r.startedAt) })] })] }, r.id))) }));
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
function formatDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()))
        return iso;
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString();
}
