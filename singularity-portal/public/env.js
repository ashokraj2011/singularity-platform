// Runtime config. OVERWRITTEN by the container entrypoint in Docker
// (singularity-portal/Dockerfile → /docker-entrypoint.d) so the portal's nav
// links can be re-pointed per deployment WITHOUT a rebuild. This empty default
// lets src/lib/env.ts fall back to build-time VITE_LINK_* and then the
// edge-gateway path defaults (/workflow, /workbench, …).
window.__ENV__ = window.__ENV__ || {};
