import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * M42.6 — Files tab. Two-column file tree + viewer. Files marked
 * protected get a small lock chip on the left rail. The viewer caps
 * at the API's 1 MB read limit.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
export function FilesTab({ runId }) {
    const [artifacts, setArtifacts] = useState(null);
    const [active, setActive] = useState(null);
    const [body, setBody] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
        let cancelled = false;
        api.listArtifacts(runId)
            .then(r => {
            if (cancelled)
                return;
            setArtifacts(r.items);
            if (r.items.length > 0 && active === null)
                setActive(r.items[0].path);
        })
            .catch(err => { if (!cancelled)
            setError(err.message); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [runId]);
    useEffect(() => {
        if (!active)
            return;
        let cancelled = false;
        setBody(null);
        api.fileContent(runId, active)
            .then(b => { if (!cancelled) {
            setBody(b);
            setError(null);
        } })
            .catch(err => { if (!cancelled)
            setError(err.message); });
        return () => { cancelled = true; };
    }, [active, runId]);
    if (error && !artifacts)
        return _jsx("div", { className: "empty", children: error });
    if (!artifacts)
        return _jsx("div", { className: "empty", children: "Loading artifacts\u2026" });
    if (artifacts.length === 0)
        return _jsx("div", { className: "empty", children: "No artifacts recorded for this run." });
    return (_jsxs("div", { className: "file-viewer", children: [_jsx("div", { className: "file-tree", children: artifacts.map(a => (_jsxs("div", { className: `row ${a.protected ? 'protected' : 'unprotected'}${active === a.path ? ' active' : ''}`, onClick: () => setActive(a.path), title: a.path, children: [_jsx("span", { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: a.path.split('/').pop() }), _jsx("span", { style: { fontSize: 10, color: 'var(--text-dim)' }, children: a.fileType })] }, a.id))) }), _jsx("div", { className: "file-body", children: error ? _jsx("div", { className: "empty", children: error })
                    : body ? _jsx("pre", { children: body.content })
                        : _jsx("div", { className: "empty", children: "Loading file\u2026" }) })] }));
}
