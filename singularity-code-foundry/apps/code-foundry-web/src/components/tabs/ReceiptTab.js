import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * M42.6 — Receipt tab. Pretty-prints the receipt JSON. Greenfield
 * receipts anchor on (specHash, irHash, templateVersion,
 * generatorVersion); brownfield receipts anchor on (repoModelHash,
 * enhancementSpecHash, changePlanHash, patchHashes[]) per §25.16.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
export function ReceiptTab({ runId }) {
    const [receipt, setReceipt] = useState(null);
    const [err, setErr] = useState(null);
    useEffect(() => {
        let cancelled = false;
        api.receipt(runId)
            .then(r => { if (!cancelled)
            setReceipt(r); })
            .catch(e => {
            if (!cancelled)
                setErr(e.message);
        });
        return () => { cancelled = true; };
    }, [runId]);
    if (err) {
        return (_jsx("div", { className: "banner warn", children: err === '404 Not Found' || /not found/i.test(err)
                ? 'No receipt has been written for this run yet. Receipts land after generation (greenfield) or apply (brownfield).'
                : err }));
    }
    if (!receipt)
        return _jsx("div", { className: "empty", children: "Loading receipt\u2026" });
    return (_jsxs("div", { className: "panel", children: [_jsx("h2", { children: "Receipt" }), _jsxs("div", { style: { display: 'flex', gap: 14, marginBottom: 12, fontSize: 12, color: 'var(--text-dim)' }, children: [_jsxs("span", { children: ["receiptHash: ", _jsx("code", { children: receipt.receiptHash })] }), _jsxs("span", { children: ["written: ", receipt.createdAt] }), _jsx("button", { onClick: () => navigator.clipboard.writeText(receipt.receiptHash), style: { padding: '2px 8px', fontSize: 11 }, children: "Copy hash" })] }), _jsx("pre", { style: { background: 'var(--code-bg)', padding: 14, borderRadius: 4, overflow: 'auto', maxHeight: '60vh' }, children: JSON.stringify(receipt.receiptJson, null, 2) })] }));
}
