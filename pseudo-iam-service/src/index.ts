/**
 * Pseudo IAM (M12) — testing-only auth shim that mirrors the real IAM wire
 * protocol but accepts ANYTHING. Login any-email-any-password, every authz
 * check passes, every capability lookup returns synthetic data so the rest
 * of the platform can run end-to-end without a real user/org/JWT.
 *
 * NOT FOR PRODUCTION. By design there is no auth at all.
 *
 * Consumers (workgraph-api, cf context-api, agent-and-tools, ...) point
 * IAM_BASE_URL at this service (default :8101) instead of real IAM (:8100).
 * Tokens are signed with the same JWT_SECRET as real IAM (default
 * "dev-secret-change-in-prod") so consumers' local-verify paths Just Work.
 */
import express, { type Request, type Response, type NextFunction } from "express";
import { SignJWT, jwtVerify } from "jose";
import { createHash, randomUUID } from "node:crypto";

const PORT       = Number(process.env.PORT ?? 8101);
const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET ?? "dev-secret-change-in-prod");

const PSEUDO_MCP_BASE_URL = process.env.PSEUDO_MCP_BASE_URL ?? "http://host.docker.internal:7100";
const PSEUDO_MCP_BEARER   = process.env.PSEUDO_MCP_BEARER   ?? "demo-bearer-token-must-be-min-16-chars";

const PLATFORM_REGISTRY_URL = process.env.PLATFORM_REGISTRY_URL ?? "";
const PUBLIC_BASE_URL       = process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function deterministicUuid(input: string): string {
  // 8-4-4-4-12 layout from the first 32 hex chars of sha256(input). Stable
  // across calls so the same email always maps to the same id.
  const h = createHash("sha256").update(input).digest("hex").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

interface UserPayload {
  sub: string; email: string; display_name?: string;
  is_super_admin: true;
}
interface ServicePayload {
  sub: string; kind: "service"; service_name: string; scopes: string[];
  issued_by: string; is_super_admin: true;
}

async function mintUserToken(email: string, ttlHours = 24): Promise<string> {
  const id = deterministicUuid(email.toLowerCase());
  return await new SignJWT({
    sub: id, email, is_super_admin: true,
  } satisfies Omit<UserPayload, "sub"> & { sub: string })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlHours}h`)
    .sign(JWT_SECRET);
}

async function mintServiceToken(opts: {
  service_name: string; scopes: string[]; ttl_hours: number; issued_by: string;
}): Promise<string> {
  return await new SignJWT({
    sub: `service:${opts.service_name}`,
    kind: "service",
    service_name: opts.service_name,
    scopes: opts.scopes,
    issued_by: opts.issued_by,
    is_super_admin: true,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${opts.ttl_hours}h`)
    .sign(JWT_SECRET);
}

// ─────────────────────────────────────────────────────────────────────────────
// M26 — device tokens (laptop-resident mcp-server)
// ─────────────────────────────────────────────────────────────────────────────
// In-memory registry. Real IAM persists in iam.user_devices (Postgres); for
// the pseudo-iam path everything lives in process.
type DeviceRecord = {
  device_id:   string;
  user_id:     string;
  email:       string;
  device_name: string;
  scopes:      string[];
  created_at:  string;
  last_seen_at: string | null;
  revoked_at:  string | null;
};
const DEVICES = new Map<string, DeviceRecord>();           // keyed by device_id
const DEVICES_BY_USER = new Map<string, Set<string>>();    // user_id → device_ids

function rememberDevice(rec: DeviceRecord) {
  DEVICES.set(rec.device_id, rec);
  const set = DEVICES_BY_USER.get(rec.user_id) ?? new Set();
  set.add(rec.device_id);
  DEVICES_BY_USER.set(rec.user_id, set);
}

async function mintDeviceToken(opts: {
  user_id: string; email: string; device_id: string; device_name: string;
  scopes: string[]; ttl_days: number;
}): Promise<string> {
  return await new SignJWT({
    sub:         opts.user_id,
    kind:        "device",
    email:       opts.email,
    device_id:   opts.device_id,
    device_name: opts.device_name,
    scopes:      opts.scopes,
    is_super_admin: true,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${opts.ttl_days}d`)
    .sign(JWT_SECRET);
}

async function decodeAny(authHeader: string | undefined): Promise<{ payload: any; userOut: any } | null> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const tok = authHeader.slice(7);
  try {
    const { payload } = await jwtVerify(tok, JWT_SECRET);
    const userOut = payload.kind === "service"
      ? { id: payload.sub, email: `${payload.service_name}@service.local`, display_name: payload.service_name, is_super_admin: true }
      : { id: payload.sub, email: payload.email ?? "user@pseudo.local", display_name: (payload as any).display_name ?? null, is_super_admin: true };
    return { payload, userOut };
  } catch {
    return null;
  }
}

const PSEUDO_NOTE = "issued by pseudo-iam — accepts everything";

// ─────────────────────────────────────────────────────────────────────────────
// app
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS — keep wide-open for dev. Pseudo-IAM is local-only.
app.use((req, res, next) => {
  res.setHeader("access-control-allow-origin", req.headers.origin ?? "*");
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,content-type,x-service-token");
  res.setHeader("access-control-allow-credentials", "true");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// public health (matches real IAM /health pattern)
app.get(["/health", "/api/v1/healthz"], (_req, res) => {
  res.json({
    status: "ok", mode: "pseudo", service: "pseudo-iam",
    warning: "NOT FOR PRODUCTION — accepts any credentials",
    timestamp: new Date().toISOString(),
  });
});

// minimal openapi stub so platform-registry contract row is valid
app.get("/openapi.json", (_req, res) => {
  res.json({
    openapi: "3.0.0",
    info: { title: "Pseudo IAM", version: "0.1.0", description: PSEUDO_NOTE },
    paths: {},
  });
});

// ── /api/v1 router ─────────────────────────────────────────────────────────
const v1 = express.Router();

// ── auth ───────────────────────────────────────────────────────────────────

v1.post("/auth/local/login", async (req, res) => {
  const email = String(req.body?.email ?? "anon@pseudo.local").toLowerCase();
  // We don't even check the password.
  const access_token = await mintUserToken(email);
  res.json({
    access_token,
    user: {
      id: deterministicUuid(email),
      email,
      display_name: email.split("@")[0],
      is_super_admin: true,
    },
    note: PSEUDO_NOTE,
  });
});

v1.post("/auth/service-token", async (req, res) => {
  const decoded = await decodeAny(req.headers.authorization);
  // Even if the bearer is missing, we still mint — pseudo-IAM accepts all.
  const issued_by = decoded?.payload?.sub ?? "pseudo:anonymous";
  const service_name = String(req.body?.service_name ?? "unknown-service");
  const scopes:    string[] = Array.isArray(req.body?.scopes) ? req.body.scopes : ["read:reference-data"];
  const ttl_hours: number   = Number(req.body?.ttl_hours ?? 24 * 30);
  const access_token = await mintServiceToken({ service_name, scopes, ttl_hours, issued_by: String(issued_by) });
  res.status(201).json({
    access_token, service_name, scopes,
    expires_in_hours: ttl_hours,
    note: PSEUDO_NOTE,
  });
});

// ─── M26 — device tokens ────────────────────────────────────────────────────
// POST /auth/device-token — mint a 90-day device JWT for the calling user.
// The 'singularity-mcp login' CLI calls this with the user's IAM JWT in the
// Authorization header. Returns a long-lived token + device record metadata.
v1.post("/auth/device-token", async (req, res) => {
  const decoded = await decodeAny(req.headers.authorization);
  // Pseudo-IAM accepts anyone — fall back to a synthetic user if no bearer.
  const user_id = String(decoded?.payload?.sub  ?? "anon-user");
  const email   = String(decoded?.payload?.email ?? "anon@pseudo.local");

  const device_id   = String(req.body?.device_id   ?? randomUUID());
  const device_name = String(req.body?.device_name ?? "unknown-device");
  const scopes: string[] = Array.isArray(req.body?.scopes) ? req.body.scopes : [];
  const ttl_days = Math.min(Number(req.body?.ttl_days ?? 90), 365);

  const access_token = await mintDeviceToken({ user_id, email, device_id, device_name, scopes, ttl_days });

  const rec: DeviceRecord = {
    device_id, user_id, email, device_name, scopes,
    created_at:  new Date().toISOString(),
    last_seen_at: null,
    revoked_at:  null,
  };
  rememberDevice(rec);

  res.status(201).json({
    access_token,
    device_id, user_id, email, device_name, scopes,
    expires_in_days: ttl_days,
    note: PSEUDO_NOTE,
  });
});

// GET /me/devices — list devices for the calling user.
v1.get("/me/devices", async (req, res) => {
  const decoded = await decodeAny(req.headers.authorization);
  const user_id = String(decoded?.payload?.sub ?? "anon-user");
  const ids = DEVICES_BY_USER.get(user_id) ?? new Set();
  const items = Array.from(ids).map(id => DEVICES.get(id)).filter(Boolean);
  res.json({ items, total: items.length });
});

// DELETE /devices/:id — revoke a device. Pseudo-IAM never enforces (accepts
// any caller); real IAM gates on owner_id.
v1.delete("/devices/:id", async (req, res) => {
  const rec = DEVICES.get(String(req.params.id));
  if (!rec) return res.status(404).json({ error: "device not found" });
  rec.revoked_at = new Date().toISOString();
  res.json({ ok: true, device: rec });
});

v1.post("/auth/verify", async (req, res) => {
  // Workgraph's primary verify path. It POSTs the token in the body OR Bearer header.
  const tok = req.body?.token ?? req.headers.authorization?.toString().replace(/^Bearer\s+/i, "");
  if (!tok) return res.status(401).json({ valid: false, reason: "no token" });
  const decoded = await decodeAny(`Bearer ${tok}`);
  if (!decoded) return res.json({ valid: true, user: { id: "anon", email: "anon@pseudo.local", display_name: "anon", is_super_admin: true }, note: PSEUDO_NOTE });
  res.json({ valid: true, user: decoded.userOut, note: PSEUDO_NOTE });
});

v1.get("/me", async (req, res) => {
  const decoded = await decodeAny(req.headers.authorization);
  if (!decoded) {
    // Even without a token, return a synthetic user (pseudo accepts all).
    return res.json({ id: "anon", email: "anon@pseudo.local", display_name: "anon", is_super_admin: true });
  }
  res.json(decoded.userOut);
});

// ── authz ──────────────────────────────────────────────────────────────────

v1.post("/authz/check", (_req, res) => {
  res.json({
    allowed: true,
    reason: "pseudo-iam-allows-everything",
    roles: ["super-admin"],
    permissions: ["*"],
    source: "pseudo-iam",
  });
});

// ── capabilities ───────────────────────────────────────────────────────────

const PSEUDO_CAPABILITIES = [
  { id: "00000000-0000-0000-0000-00000000aaaa", capability_id: "pseudo-cap-1", name: "Pseudo Capability 1", capability_type: "business_capability", status: "active", description: "auto-generated by pseudo-iam" },
  { id: "00000000-0000-0000-0000-00000000bbbb", capability_id: "pseudo-cap-2", name: "Pseudo Capability 2", capability_type: "business_capability", status: "active", description: "auto-generated by pseudo-iam" },
  { id: "82cec330-1742-4297-b5de-1a309f0995bd", capability_id: "tag-test",     name: "Tag Test (parity row)", capability_type: "business_capability", status: "active", description: "matches real IAM seed for cross-mode demos" },
];

function syntheticCapability(id: string) {
  const known = PSEUDO_CAPABILITIES.find((c) => c.id === id || c.capability_id === id);
  if (known) return known;
  return {
    id, capability_id: id,
    name: `Pseudo Capability ${id.slice(0, 8)}`,
    capability_type: "business_capability", status: "active",
    description: PSEUDO_NOTE,
  };
}

v1.get("/capabilities", (req, res) => {
  const page = Math.max(1, Number(req.query.page ?? 1));
  const size = Math.min(200, Math.max(1, Number(req.query.size ?? 50)));
  const start = (page - 1) * size;
  const items = PSEUDO_CAPABILITIES.slice(start, start + size);
  res.json({ items, total: PSEUDO_CAPABILITIES.length, page, size });
});

v1.get("/capabilities/:id", (req, res) => {
  res.json(syntheticCapability(req.params.id));
});

v1.get("/capabilities/:id/members", (req, res) => {
  res.json([
    { user_id: deterministicUuid("pseudo-admin@local"), team_id: null, capability_id: req.params.id, role_key: "super-admin" },
  ]);
});

v1.get("/capabilities/:id/relationships", (_req, res) => res.json([]));

// ── MCP servers (so cf /execute works against the real local mcp-server) ──
//
// Returns ONE registered MCP entry per capability — pointing at the running
// mcp-server-demo (defaults: http://host.docker.internal:7100, the
// MCP_BEARER_TOKEN). Configurable via PSEUDO_MCP_BASE_URL/PSEUDO_MCP_BEARER.

const PSEUDO_MCP_ID = "00000000-0000-0000-0000-mcpsrv00pseudo";

function mcpServerRecord(capabilityId: string) {
  return {
    id: PSEUDO_MCP_ID,
    capability_id: capabilityId,
    name: "pseudo-mcp",
    description: "MCP server registered by pseudo-iam (points at local mcp-server-demo)",
    base_url: PSEUDO_MCP_BASE_URL,
    auth_method: "BEARER_TOKEN",
    bearer_token: PSEUDO_MCP_BEARER,
    protocol: "MCP_HTTP", protocol_version: "0.1",
    status: "active", metadata: {}, tags: [],
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
}

v1.get("/capabilities/:id/mcp-servers", (req, res) => {
  // Real IAM returns the redacted list (no bearer); mirror that shape here.
  const r = mcpServerRecord(req.params.id);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { bearer_token: _, ...redacted } = r;
  res.json([redacted]);
});

v1.get("/mcp-servers/:id", (_req, res) => {
  // The full record — INCLUDING bearer_token — for cf to dial the MCP.
  res.json(mcpServerRecord("pseudo-cap"));
});

// ── reference data (so federated lookups don't 404/empty) ──────────────────

const PSEUDO_USERS = [
  { id: deterministicUuid("admin@pseudo.local"),   email: "admin@pseudo.local",   display_name: "Pseudo Admin", is_super_admin: true,  status: "active" },
  { id: deterministicUuid("alice@pseudo.local"),  email: "alice@pseudo.local",  display_name: "Alice",         is_super_admin: false, status: "active" },
  { id: deterministicUuid("bob@pseudo.local"),    email: "bob@pseudo.local",    display_name: "Bob",           is_super_admin: false, status: "active" },
];

v1.get("/users", (req, res) => {
  const page = Math.max(1, Number(req.query.page ?? 1));
  const size = Math.min(200, Math.max(1, Number(req.query.size ?? 50)));
  const start = (page - 1) * size;
  res.json({ items: PSEUDO_USERS.slice(start, start + size), total: PSEUDO_USERS.length, page, size });
});

v1.get("/users/:id", (req, res) => {
  const known = PSEUDO_USERS.find((u) => u.id === req.params.id);
  if (known) return res.json(known);
  res.json({
    id: req.params.id,
    email: `${req.params.id.slice(0, 8)}@pseudo.local`,
    display_name: `Pseudo User ${req.params.id.slice(0, 8)}`,
    is_super_admin: true, status: "active",
  });
});

// Multi-tenant model: User ↔ Team(role) ↔ Capability. The picker on login
// reads /me/memberships and lets the user choose {capability, role}.
//
// Pseudo data: admins (email starts with "admin") get the cross-product of
// every capability × every role. Other users get a single editor membership
// on the first capability so the picker has something to show but skips the
// pick step (UI auto-selects when length === 1).

interface Membership {
  capability_id: string;
  capability_name: string;
  team_id: string;
  team_name: string;
  role_key: string;
  role_name: string;
  is_capability_owner: boolean;
}

function buildMemberships(userEmail: string): Membership[] {
  const local = userEmail.split("@")[0]?.toLowerCase() ?? "";
  if (local.startsWith("admin") || local === "anon") {
    const out: Membership[] = [];
    for (const cap of PSEUDO_CAPABILITIES) {
      for (const role of PSEUDO_ROLES) {
        out.push({
          capability_id: cap.id,
          capability_name: cap.name,
          team_id: PSEUDO_TEAMS[0].id,
          team_name: PSEUDO_TEAMS[0].name,
          role_key: role.role_key,
          role_name: role.name,
          is_capability_owner: role.role_key === "super-admin",
        });
      }
    }
    return out;
  }
  // alice → editor on cap-1; bob → viewer on cap-2; everyone else → editor on cap-1.
  if (local === "alice") {
    return [
      { capability_id: PSEUDO_CAPABILITIES[0].id, capability_name: PSEUDO_CAPABILITIES[0].name, team_id: PSEUDO_TEAMS[0].id, team_name: PSEUDO_TEAMS[0].name, role_key: "editor", role_name: "Editor", is_capability_owner: false },
      { capability_id: PSEUDO_CAPABILITIES[1].id, capability_name: PSEUDO_CAPABILITIES[1].name, team_id: PSEUDO_TEAMS[1].id, team_name: PSEUDO_TEAMS[1].name, role_key: "viewer", role_name: "Viewer", is_capability_owner: false },
    ];
  }
  if (local === "bob") {
    return [
      { capability_id: PSEUDO_CAPABILITIES[1].id, capability_name: PSEUDO_CAPABILITIES[1].name, team_id: PSEUDO_TEAMS[1].id, team_name: PSEUDO_TEAMS[1].name, role_key: "viewer", role_name: "Viewer", is_capability_owner: false },
    ];
  }
  return [
    { capability_id: PSEUDO_CAPABILITIES[0].id, capability_name: PSEUDO_CAPABILITIES[0].name, team_id: PSEUDO_TEAMS[0].id, team_name: PSEUDO_TEAMS[0].name, role_key: "editor", role_name: "Editor", is_capability_owner: false },
  ];
}

v1.get("/users/:id/teams", (req, res) => {
  const ms = buildMemberships(`${req.params.id.slice(0, 8)}@pseudo.local`);
  const seen = new Set<string>();
  const teams = ms.filter((m) => { if (seen.has(m.team_id)) return false; seen.add(m.team_id); return true; }).map((m) => ({ id: m.team_id, name: m.team_name }));
  res.json(teams);
});

v1.get("/users/:id/memberships", async (req, res) => {
  // We don't have the email from the id alone; try to recover it from a
  // bearer token if present, else fall back to the deterministic-uuid lookup.
  const decoded = await decodeAny(req.headers.authorization);
  const email   = decoded?.payload?.email ?? PSEUDO_USERS.find((u) => u.id === req.params.id)?.email ?? "anon@pseudo.local";
  res.json(buildMemberships(String(email)));
});

v1.get("/me/memberships", async (req, res) => {
  const decoded = await decodeAny(req.headers.authorization);
  const email = decoded?.payload?.email ?? "anon@pseudo.local";
  res.json(buildMemberships(String(email)));
});

v1.get("/users/:id/skills", (_req, res) => res.json([]));

const PSEUDO_TEAMS = [
  { id: "10000000-0000-0000-0000-000000000001", team_key: "platform",      name: "Platform Team", bu_id: null },
  { id: "10000000-0000-0000-0000-000000000002", team_key: "applications",  name: "Applications Team", bu_id: null },
];
v1.get("/teams", (_req, res) => res.json({ items: PSEUDO_TEAMS, total: PSEUDO_TEAMS.length, page: 1, size: PSEUDO_TEAMS.length }));
v1.get("/teams/:id", (req, res) => {
  const t = PSEUDO_TEAMS.find((x) => x.id === req.params.id) ?? { id: req.params.id, team_key: req.params.id, name: `Pseudo Team ${req.params.id.slice(0, 8)}`, bu_id: null };
  res.json(t);
});
v1.get("/teams/:id/members", (_req, res) => res.json([]));

const PSEUDO_BUS = [{ id: "20000000-0000-0000-0000-000000000001", bu_key: "core", name: "Core Business Unit" }];
v1.get("/business-units", (_req, res) => res.json({ items: PSEUDO_BUS, total: 1, page: 1, size: 1 }));
v1.get("/business-units/:id", (req, res) => {
  const b = PSEUDO_BUS.find((x) => x.id === req.params.id) ?? { id: req.params.id, bu_key: req.params.id, name: `Pseudo BU ${req.params.id.slice(0, 8)}` };
  res.json(b);
});

const PSEUDO_ROLES = [
  { id: "30000000-0000-0000-0000-000000000001", role_key: "viewer",      name: "Viewer",      role_scope: "capability" },
  { id: "30000000-0000-0000-0000-000000000002", role_key: "editor",      name: "Editor",      role_scope: "capability" },
  { id: "30000000-0000-0000-0000-000000000003", role_key: "super-admin", name: "Super Admin", role_scope: "platform"   },
];
v1.get("/roles", (_req, res) => res.json({ items: PSEUDO_ROLES, total: PSEUDO_ROLES.length, page: 1, size: PSEUDO_ROLES.length }));
v1.get("/roles/:role_key", (req, res) => {
  const r = PSEUDO_ROLES.find((x) => x.role_key === req.params.role_key) ?? { id: randomUUID(), role_key: req.params.role_key, name: req.params.role_key, role_scope: "capability" };
  res.json(r);
});

v1.get("/skills", (_req, res) => res.json({ items: [], total: 0, page: 1, size: 50 }));

// ── catch-all under /api/v1 — return empty/synthetic so consumers don't crash
v1.use((req, res) => {
  res.status(404).json({ code: "NOT_FOUND", path: req.originalUrl, note: PSEUDO_NOTE });
});

app.use("/api/v1", v1);

// ─────────────────────────────────────────────────────────────────────────────
// platform-registry self-register (best-effort, non-blocking)
// ─────────────────────────────────────────────────────────────────────────────

async function selfRegister(): Promise<void> {
  if (!PLATFORM_REGISTRY_URL) return;
  const url = `${PLATFORM_REGISTRY_URL.replace(/\/$/, "")}/api/v1/register`;
  const payload = {
    service_name: "pseudo-iam",
    display_name: "Pseudo IAM (testing)",
    version: "0.1.0",
    base_url: PUBLIC_BASE_URL,
    health_path: "/health",
    auth_mode: "none",
    owner_team: "platform",
    metadata: { mode: "pseudo", warning: "NOT FOR PRODUCTION" },
    capabilities: [
      { capability_key: "auth.login.any",        description: "Accepts any email/password" },
      { capability_key: "auth.service-token",    description: "Mints service tokens with no validation" },
      { capability_key: "authz.allow-all",       description: "All authz checks return allowed=true" },
      { capability_key: "identity.synthetic",    description: "Synthetic users / teams / capabilities for testing" },
      { capability_key: "mcp-servers.local",     description: "Returns local mcp-server-demo as the registered MCP" },
    ],
    contracts: [
      { kind: "openapi", contract_key: "openapi", version: "0.1.0", source_url: `${PUBLIC_BASE_URL}/openapi.json` },
    ],
  };
  try {
    const res = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.warn(`[pseudo-iam] self-register failed (${res.status})`);
    else console.log(`[pseudo-iam] self-registered with platform-registry at ${url}`);
  } catch (err) {
    console.warn(`[pseudo-iam] self-register errored: ${(err as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[pseudo-iam] listening on :${PORT} (mode=pseudo, NOT FOR PRODUCTION)`);
  console.log(`[pseudo-iam] JWT_SECRET length=${JWT_SECRET.length}; tokens valid for 24h (user) / 30d (service)`);
  console.log(`[pseudo-iam] MCP routing → ${PSEUDO_MCP_BASE_URL}`);
  void selfRegister();
});
