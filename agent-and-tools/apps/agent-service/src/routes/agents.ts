import { Router, Request, Response } from "express";
import { createHash } from "crypto";
import { query, queryOne } from "../database";
import { optionalAuth } from "../middleware/auth";
import { emitAuditEvent } from "../middleware/audit";
import { AppError } from "../middleware/errorHandler";

export const agentRoutes = Router();
agentRoutes.use(optionalAuth);

// POST /api/v1/agents
agentRoutes.post("/", async (req: Request, res: Response) => {
  const { capability_id, agent_id, name, description, agent_type, owner_user_id, owner_team_id, metadata } = req.body;

  if (!capability_id || !agent_id || !name) {
    throw new AppError("capability_id, agent_id, and name are required");
  }

  const agent_key = `${capability_id}:${agent_id}`;
  const agent_uid = `sha256:${createHash("sha256").update(agent_key).digest("hex")}`;

  const existing = await queryOne("SELECT id FROM agent.agents WHERE agent_key = $1", [agent_key]);
  if (existing) throw new AppError(`Agent '${agent_key}' already exists`, 409);

  const [agent] = await query(
    `INSERT INTO agent.agents (capability_id, agent_id, agent_key, agent_uid, name, description, agent_type, owner_user_id, owner_team_id, metadata, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      capability_id, agent_id, agent_key, agent_uid, name,
      description ?? null, agent_type ?? "llm_agent",
      owner_user_id ?? null, owner_team_id ?? null,
      JSON.stringify(metadata ?? {}),
      req.user?.user_id ?? null,
    ]
  );

  await emitAuditEvent("agent.created", { agent_uid, capability_id, agent_id, actor_user_id: req.user?.user_id });
  res.status(201).json({ agent_uid, agent_key, status: "draft", agent });
});

// GET /api/v1/agents
agentRoutes.get("/", async (req: Request, res: Response) => {
  const { capability_id, status } = req.query;
  let sql = "SELECT * FROM agent.agents WHERE 1=1";
  const params: unknown[] = [];

  if (capability_id) { params.push(capability_id); sql += ` AND capability_id = $${params.length}`; }
  if (status) { params.push(status); sql += ` AND status = $${params.length}`; }
  sql += " ORDER BY created_at DESC";

  const agents = await query(sql, params);
  res.json({ agents });
});

// GET /api/v1/agents/:uid
agentRoutes.get("/:uid", async (req: Request, res: Response) => {
  const agent = await queryOne("SELECT * FROM agent.agents WHERE agent_uid = $1", [req.params.uid]);
  if (!agent) throw new AppError("Agent not found", 404);
  res.json(agent);
});

// PATCH /api/v1/agents/:uid/status
agentRoutes.patch("/:uid/status", async (req: Request, res: Response) => {
  const { status } = req.body;
  const allowed = ["draft", "pending_approval", "active", "suspended", "archived"];
  if (!allowed.includes(status)) throw new AppError(`Invalid status. Must be one of: ${allowed.join(", ")}`);

  const agent = await queryOne(
    "UPDATE agent.agents SET status=$1, updated_at=now() WHERE agent_uid=$2 RETURNING *",
    [status, req.params.uid]
  );
  if (!agent) throw new AppError("Agent not found", 404);

  await emitAuditEvent("agent.status_changed", { agent_uid: req.params.uid, actor_user_id: req.user?.user_id, data: { status } });
  res.json(agent);
});

// GET /api/v1/agents/:uid/audit
agentRoutes.get("/:uid/audit", async (req: Request, res: Response) => {
  const events = await query(
    "SELECT * FROM agent.agent_audit_events WHERE agent_uid=$1 ORDER BY created_at DESC LIMIT 100",
    [req.params.uid]
  );
  res.json({ events });
});
