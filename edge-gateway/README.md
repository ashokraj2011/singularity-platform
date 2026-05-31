# Edge Gateway — single operator origin (M100)

The edge gateway is a thin nginx reverse proxy that fronts **all six platform
UIs on one origin** so an operator has a single entry point, one session
(shared-localStorage SSO), and one canonical nav — instead of six apps on six
ports each with its own login.

- **Canonical entry:** `http://localhost:8085/`
  (host port **8085**; container listens on 80. 8090 is intentionally avoided —
  it's reserved for `PLATFORM_REGISTRY_URL`.)
- **Compose service:** `edge-gateway` (profile `full`), built from this dir.
- **Config:** [`nginx.conf`](./nginx.conf) (copied into the image by
  [`Dockerfile`](./Dockerfile)).

> The browser only ever talks to `:8085`. The individual app host ports
> (`:5174`, `:5176`, …) are **not** the supported entry anymore — they're kept
> only for debugging and are prefix-bound (their built assets resolve under
> `/workflow/` etc.), so opening them directly will not work.

---

## Routing table

The edge resolves upstreams by **Docker service name** via the embedded DNS
(`resolver 127.0.0.11`), so the gateway and the app containers **must be on the
same Docker network** (the `singularity` network). The browser never reaches the
upstream ports directly.

| URL prefix | Upstream (service:port) | Strategy | Why |
|---|---|---|---|
| `/`           | `portal:80`                | pass-through (root) | Portal owns `/`, `/login`, `/api/*`, `/ops-health/*` |
| `/agent`      | `agent-web:3000`           | **pass-through**    | Next.js `basePath=/agent` owns the prefix |
| `/workflow/`  | `workgraph-web:80`         | **strip**           | Built Vite SPA served at root by its own nginx |
| `/workbench/` | `blueprint-workbench:80`   | **strip** + SSE     | Built Vite SPA; loop-theater/test-runner stream SSE |
| `/foundry/`   | `code-foundry-web:5181`    | **pass-through** + HMR ws | Vite **dev** server owns the prefix |
| `/iam/`       | `user-and-capability:80`   | **strip**           | Built Vite SPA |

- **strip** = `rewrite ^/<prefix>/(.*)$ /$1 break;` — the app's own nginx serves
  the SPA at root and proxies its `/api/*` unchanged. The SPA is *built* with the
  prefix (so its asset URLs are namespaced) and the edge strips the prefix back
  off before proxying.
- **pass-through** = the prefix is forwarded verbatim because the framework owns
  its own base path (Next `basePath`, Vite-dev `base`). WebSocket upgrade headers
  are forwarded (Next/Vite HMR, laptop bridge).

---

## Where the links/paths are configured (3 layers)

1. **Edge routing** (path → container): this dir's [`nginx.conf`](./nginx.conf).
2. **Per-app subpath base** (so assets/routes namespace under the prefix):
   the `BASE_PATH` **build arg** in `docker-compose.yml` (Vite `base` /
   Next `basePath`), default `/`. Each app's API client is base-relative
   (`${import.meta.env.BASE_URL}api`; Next basePath auto-prefixes its rewrites).
3. **Nav-link targets** (what a "Workflow Manager" button points to) — same-origin
   path by default, overridable per deployment:

   | App | File | Override env |
   |---|---|---|
   | Portal | `singularity-portal/src/lib/env.ts` (`links` → `AppSwitcher`/`AppLayout`) | `VITE_LINK_*` |
   | workgraph-web / workbench / iam | `…/src/components/AppSwitcher.tsx` (`useAppLinks`) | `VITE_LINK_*` |
   | agent-web (Next) | `agent-and-tools/web/src/lib/controlPlaneApps.ts` | `NEXT_PUBLIC_LINK_*` |

   Default (env unset) → same-origin paths: `/operations`, `/agent`, `/workflow`,
   `/workbench/?ui=neo`, `/foundry`, `/iam`. Set the `*_LINK_*` env to an absolute
   URL only for a **split-origin** deployment.

---

## SSO (single sign-on)

One origin ⇒ `localStorage` is shared across all prefixes. The portal owns login
and persists the session under the canonical key **`singularity-portal.auth`**.
Sub-apps read that key first (via a small `sharedAuth`/`apiPath`-style accessor),
falling back to their legacy store only when run standalone. All backends share
`JWT_SECRET` and IAM exposes `/api/v1/auth/verify`, so one IAM JWT is accepted
everywhere.

---

## Adding a new app behind the gateway

1. Give the SPA a `BASE_PATH` build arg (Vite `base` / Next `basePath`) and make
   its API client base-relative.
2. Add a `location /<prefix>/ { … }` block in `nginx.conf` (strip for a
   built-nginx SPA, pass-through for a dev server / Next basePath). Add the bare
   redirect `location = /<prefix> { return 302 /<prefix>/; }` for built SPAs.
3. Add the service + `BASE_PATH` build arg to `docker-compose.yml` and list it
   under the gateway's `depends_on`.
4. Add a nav entry (same-origin path) to the portal + sub-app switchers.

---

## Gotchas (learned the hard way)

- **`absolute_redirect off;`** is set in `nginx.conf`. nginx defaults to
  `absolute_redirect on`, which rewrites `return 302 /workflow/` to an *absolute*
  URL using nginx's listen port (80) — dropping the host-published `:8085` and
  sending the browser to a dead `http://localhost/workflow/`. Keeping redirects
  relative makes the browser preserve the `:8085` origin.
- **Don't bake dev `.env.local` into prod images.** Vite reads `.env.local` at
  build time; a dev `VITE_LINK_*=http://localhost:<port>` there overrides the
  same-origin defaults and ships the wrong links. Frontends that have a dev
  `.env.local` must carry a `.dockerignore` excluding `.env`/`.env.local`
  (see `singularity-portal/.dockerignore`).
- **Every client absolute path must be base-relative**, not just the central
  API client — raw `fetch('/api/…')`, `new EventSource('/api/…')`,
  `new URL('/api/…')`, and cross-app nav links all need the prefix (Vite:
  `import.meta.env.BASE_URL`; Next: `NEXT_PUBLIC_BASE_PATH`). Raw `fetch` is NOT
  auto-prefixed by Next basePath.
- **Standalone host ports are prefix-bound** after building with `BASE_PATH`;
  use `:8085`. Reverse the whole thing by rebuilding with `BASE_PATH=/` and
  dropping the `edge-gateway` service.

---

## Verify (curl, no auth needed for routing)

```sh
E=http://localhost:8085
curl -s -o /dev/null -w "%{http_code}\n" $E/healthz          # 200 (gateway self-health)
for p in / /agent /workflow/ /workbench/ /foundry/ /iam/; do
  curl -s -o /dev/null -w "$p -> %{http_code}\n" "$E$p"       # all 200
done
curl -s -o /dev/null -D - "$E/workflow" | grep -i '^location' # Location: /workflow/  (RELATIVE)
curl -s -o /dev/null -w "%{http_code}\n" "$E/workflow/api/workflows"  # 401 (reaches workgraph-api)
```

Authenticated SSO + nav click-through must be validated in a browser at
`http://localhost:8085/` — those can't be exercised headlessly.
