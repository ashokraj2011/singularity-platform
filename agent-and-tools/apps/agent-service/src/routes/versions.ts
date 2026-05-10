import { Router, Request, Response } from "express";
import { query, queryOne } from "../database";
import { optionalAuth } from "../middleware/auth";
import { emitAuditEvent } from "../middleware/audit";
import { AppError } from "../middleware/errorHandler";

export const versionRoutes = Router();
versionRoutes.use(optionalAuth);

// POST /api/v1/agents/:uid/versions
versionRoutes.post("/:uid/versions", async (req: Request, res: Response) => {
  const { uid } = req.params;
  const { system_prompt, behavior_policy, model_policy, context_policy, tool_policy, approval_policy, change_reason } = req.body;

  if (!system_prompt) throw new AppError("system_prompt is required");

  const agent = await queryOne("SELECT agent_uid, capability_id, agent_id FROM agent.agents WHERE agent_uid=$1", [uid]);
  if (!agent) throw new AppError("Agent not found", 404);

  const last = await queryOne<{ version: number }>(
    "SELECT COALESCE(MAX(version), 0) as version FROM agent.agent_versions WHERE agent_uid=$1",
    [uid]
  );
  const nextVersion = (last?.version ?? 0) + 1;

  const [version] = await query(
    `INSERT INTO agent.agent_versions
       (agent_uid, version, status, system_prompt, behavior_policy, model_policy, context_policy, tool_policy, approval_policy, change_reason, created_by)
     VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      uid, nextVersion, system_prompt,
      JSON.stringify(behavior_policy ?? {}),
      JSON.stringify(model_policy ?? {}),
      JSON.stringify(context_policy ?? {}),
      JSON.stringify(tool_policy ?? {}),
      JSON.stringify(approval_policy ?? {}),
      change_reason ?? null,
      req.user?.user_id ?? null,
    ]
  );

  const a = agent as { agent_uid: string; capability_id: string; agent_id: string };
  await emitAuditEvent("agent.version_created", {
    agent_uid: uid, capability_id: a.capability_id, agent_id: a.agent_id,
    actor_user_id: req.user?.user_id, data: { version: nextVersion },
  });

  res.status(201).json(version);
});

// GET /api/v1/agents/:uid/versions
versionRoutes.get("/:uid/versions", async (req: Request, res: Response) => {
  const versions = await query(
    "SELECT * FROM agent.agent_versions WHERE agent_uid=$1 ORDER BY version DESC",
    [req.params.uid]
  );
  res.json({ versions });
});

// POST /api/v1/agents/:uid/versions/:version/activate
versionRoutes.post("/:uid/versions/:version/activate", async (req: Request, res: Response) => {
  const { uid, version } = req.params;

  const vRow = await queryOne(
    "SELECT * FROM agent.agent_versions WHERE agent_uid=$1 AND version=$2",
    [uid, Number(version)]
  );
  if (!vRow) throw new AppError("Version not found", 404);

  // Supersede any currently active version
  await query(
    "UPDATE agent.agent_versions SET status='superseded' WHERE agent_uid=$1 AND status='active'",
    [uid]
  );

  const [activated] = await query(
    "UPDATE agent.agent_versions SET status='active', approved_by=$1, approved_at=now() WHERE agent_uid=$2 AND version=$3 RETURNING *",
    [req.user?.user_id ?? null, uid, Number(version)]
  );

  await query("UPDATE agent.agents SET status='active', updated_at=now() WHERE agent_uid=$1", [uid]);

  const agent = await queryOne<{ capability_id: string; agent_id: string }>(
    "SELECT capability_id, agent_id FROM agent.agents WHERE agent_uid=$1", [uid]
  );
  await emitAuditEvent("agent.version_activated", {
    agent_uid: uid, capability_id: agent?.capability_id, agent_id: agent?.agent_id,
    actor_user_id: req.user?.user_id, data: { version: Number(version) },
  });

  res.json(activated);
});
