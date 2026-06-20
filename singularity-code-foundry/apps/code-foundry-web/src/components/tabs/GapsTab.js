import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * M42.6 — Gaps tab. Read-only table of CodegenGap rows. Severity is
 * colour-coded; the region anchor is shown when present so the
 * operator can correlate a gap to its <llm-editable> fence.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
export function GapsTab({ runId }) {
    const [gaps, setGaps] = useState(null);
    const [err, setErr] = useState(null);
    useEffect(() => {
        let cancelled = false;
        api.listGaps(runId)
            .then(r => { if (!cancelled)
            setGaps(r.items); })
            .catch(e => { if (!cancelled)
            setErr(e.message); });
        return () => { cancelled = true; };
    }, [runId]);
    if (err)
        return _jsx("div", { className: "empty", children: err });
    if (!gaps)
        return _jsx("div", { className: "empty", children: "Loading gaps\u2026" });
    if (gaps.length === 0)
        return _jsx("div", { className: "empty", children: "No gaps detected for this run." });
    return (_jsxs("div", { className: "panel", children: [_jsx("h2", { children: "Gaps" }), _jsxs("table", { children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Type" }), _jsx("th", { children: "Severity" }), _jsx("th", { children: "File" }), _jsx("th", { children: "Region" }), _jsx("th", { children: "Resolved" }), _jsx("th", { children: "LLM" }), _jsx("th", { children: "Description" })] }) }), _jsx("tbody", { children: gaps.map(g => (_jsxs("tr", { children: [_jsx("td", { children: _jsx("code", { children: g.gapType }) }), _jsx("td", { style: { color: severityColor(g.severity) }, children: g.severity }), _jsx("td", { children: _jsx("code", { children: g.filePath ?? '—' }) }), _jsx("td", { children: g.regionId ?? '—' }), _jsx("td", { children: g.resolved ? '✓' : '—' }), _jsx("td", { children: g.llmEligible ? '✓' : '—' }), _jsx("td", { children: g.description })] }, g.id))) })] })] }));
}
function severityColor(s) {
    switch (s) {
        case 'critical': return 'var(--bad)';
        case 'high': return 'var(--bad)';
        case 'medium': return 'var(--warn)';
        case 'low': return 'var(--text-dim)';
    }
}
