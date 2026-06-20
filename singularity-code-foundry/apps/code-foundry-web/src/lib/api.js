class ApiError extends Error {
    status;
    body;
    constructor(status, message, body) {
        super(message);
        this.status = status;
        this.body = body;
    }
}
// M100 P1 — prefix every API path with the Vite base so that behind the
// single-origin edge gateway (base '/foundry/') requests go to /foundry/api/*
// and route to this app; standalone (base '/') it stays /api/*.
const viteEnv = import.meta.env ?? {};
const API_PREFIX = (viteEnv.BASE_URL ?? '/').replace(/\/$/, '');
function getToken() {
    // M100 P0 — the SERVICE token is NOT read from a build-time env var anymore
    // (that baked it into the browser bundle). The same-origin `/api` proxy
    // injects it server-side from FOUNDRY_TOKEN (see vite.config.ts). The only
    // token the client supplies is an OPERATOR-pasted one from localStorage —
    // the user's own credential, not a shared secret.
    try {
        const v = localStorage.getItem('foundry.token');
        if (v)
            return v;
    }
    catch { /* ignore SSR / private mode */ }
    return null;
}
async function request(path, init) {
    const headers = new Headers(init?.headers);
    if (!headers.has('content-type') && init?.body && typeof init.body === 'string') {
        headers.set('content-type', 'application/json');
    }
    const token = getToken();
    if (token)
        headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(`${API_PREFIX}${path}`, { ...init, headers });
    let body;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json'))
        body = await res.json();
    else
        body = await res.text();
    if (!res.ok) {
        const msg = typeof body === 'object' && body && 'message' in body
            ? String(body.message)
            : `${res.status} ${res.statusText}`;
        throw new ApiError(res.status, msg, body);
    }
    return body;
}
export const api = {
    health: () => request(`/health`),
    listRuns: (params = {}) => {
        const q = new URLSearchParams();
        if (params.take !== undefined)
            q.set('take', String(params.take));
        if (params.skip !== undefined)
            q.set('skip', String(params.skip));
        if (params.mode)
            q.set('mode', params.mode);
        if (params.status)
            q.set('status', params.status);
        return request(`/api/codegen/runs?${q.toString()}`);
    },
    getRun: (runId) => request(`/api/codegen/runs/${runId}`),
    listArtifacts: (runId) => request(`/api/codegen/runs/${runId}/artifacts`),
    fileContent: (runId, path) => request(`/api/codegen/runs/${runId}/file?path=${encodeURIComponent(path)}`),
    listGaps: (runId) => request(`/api/codegen/runs/${runId}/gaps`),
    listLlmTasks: (runId) => request(`/api/codegen/runs/${runId}/llm-tasks`),
    receipt: (runId) => request(`/api/codegen/runs/${runId}/receipt`),
    dispatchTask: (taskId) => request(`/api/codegen/llm-tasks/${taskId}/dispatch`, { method: 'POST', body: '{}' }),
    applyPatch: (taskId, diff) => request(`/api/codegen/llm-tasks/${taskId}/apply-patch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ diff }),
    }),
    listRepos: () => request(`/api/codegen/repos`),
    listChangePlans: (repoModelId) => {
        const q = repoModelId ? `?repoModelId=${encodeURIComponent(repoModelId)}` : '';
        return request(`/api/codegen/change-plans${q}`);
    },
};
export { ApiError };
