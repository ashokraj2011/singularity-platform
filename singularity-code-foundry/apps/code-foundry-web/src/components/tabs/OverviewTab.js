import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * M42.6 — Overview tab. Spec hashes, template + generator versions,
 * output path, and (for brownfield) the change plan summary.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
export function OverviewTab({ run }) {
    return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "panel", children: [_jsx("h2", { children: "Run" }), _jsx("table", { children: _jsxs("tbody", { children: [_jsxs("tr", { children: [_jsx("th", { children: "Generator" }), _jsx("td", { children: run.generatorVersion })] }), _jsxs("tr", { children: [_jsx("th", { children: "Template" }), _jsx("td", { children: run.templateVersion })] }), _jsxs("tr", { children: [_jsx("th", { children: "Started" }), _jsx("td", { children: run.startedAt })] }), _jsxs("tr", { children: [_jsx("th", { children: "Completed" }), _jsx("td", { children: run.completedAt ?? '—' })] }), _jsxs("tr", { children: [_jsx("th", { children: "Output path" }), _jsx("td", { children: _jsx("code", { children: run.outputPath ?? '—' }) })] }), run.spec?.specHash && _jsxs("tr", { children: [_jsx("th", { children: "Spec hash" }), _jsx("td", { children: _jsx("code", { children: run.spec.specHash }) })] }), run.spec?.irHash && _jsxs("tr", { children: [_jsx("th", { children: "IR hash" }), _jsx("td", { children: _jsx("code", { children: run.spec.irHash }) })] }), run.receipt?.receiptHash && _jsxs("tr", { children: [_jsx("th", { children: "Receipt hash" }), _jsx("td", { children: _jsx("code", { children: run.receipt.receiptHash }) })] })] }) })] }), run.mode === 'BROWNFIELD' && run.changePlan ? (_jsx(BrownfieldPanel, { run: run })) : null] }));
}
function BrownfieldPanel({ run }) {
    const [planMeta, setPlanMeta] = useState(null);
    useEffect(() => {
        if (!run.changePlan?.repoModelId)
            return;
        let cancelled = false;
        api.listChangePlans(run.changePlan.repoModelId)
            .then(r => {
            if (cancelled)
                return;
            const row = r.items.find(i => i.id === run.changePlan?.id);
            if (row)
                setPlanMeta({ status: row.status, planHash: row.planHash, appliedAt: row.appliedAt, createdAt: row.createdAt });
        })
            .catch(() => { });
        return () => { cancelled = true; };
    }, [run.changePlan?.id, run.changePlan?.repoModelId]);
    return (_jsxs("div", { className: "panel", children: [_jsx("h2", { children: "Brownfield Change Plan" }), _jsx("table", { children: _jsxs("tbody", { children: [_jsxs("tr", { children: [_jsx("th", { children: "Plan id" }), _jsx("td", { children: _jsx("code", { children: run.changePlan?.id }) })] }), _jsxs("tr", { children: [_jsx("th", { children: "Plan hash" }), _jsx("td", { children: _jsx("code", { children: run.changePlan?.planHash }) })] }), _jsxs("tr", { children: [_jsx("th", { children: "Status" }), _jsx("td", { children: planMeta?.status ?? run.changePlan?.status })] }), _jsxs("tr", { children: [_jsx("th", { children: "Repo model" }), _jsx("td", { children: _jsx("code", { children: run.changePlan?.repoModelId }) })] }), planMeta?.appliedAt && _jsxs("tr", { children: [_jsx("th", { children: "Applied at" }), _jsx("td", { children: planMeta.appliedAt })] })] }) })] }));
}
