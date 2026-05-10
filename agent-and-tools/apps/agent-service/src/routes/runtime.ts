import { Router, Request, Response } from "express";
import { createHash } from "crypto";
import { query, queryOne } from "../database";
import { optionalAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";

export const runtimeRoutes = Router();
runtimeRoutes.use(optionalAuth);

// GET /api/v1/agents/runtime-profile?capability_id=&agent_id=
runtimeRoutes.get("/agents/runtime-profile", async (req: Request, res: Response) => {
  const { capability_id, agent_id } = req.query as Record<string, string>;
  if (!capability_id || !agent_id) throw new AppError("capability_id and agent_id are required");

  const agent = await queryOne<Record<string, unknown>>(
    "SELECT * FROM agent.agents WHERE capability_id=$1 AND agent_id=$2 AND status='active'",
    [capability_id, agent_id]
  );
  if (!agent) throw new AppError("No active agent found for given capability and agent_id", 404);

  const uid = agent.agent_uid as string;

  const activeVersion = await queryOne<Record<string, unknown>>(
    "SELECT * FROM agent.agent_versions WHERE agent_uid=$1 AND status='active'",
    [uid]
  );
  if (!activeVersion) throw new AppError("No active version for this agent", 404);

  const learningProfile = await queryOne<Record<string, unknown>>(
    `SELECT profile_type, version, summary_text
     FROM agent.agent_learning_profiles
     WHERE agent_uid=$1 AND status='active'
     ORDER BY version DESC LIMIT 1`,
    [uid]
  );

  const profileHash = createHash("sha256")
    .update(`${uid}-${activeVersion.version}-${learningProfile?.version ?? 0}`)
    .digest("hex");

  res.json({
    capability_id,
    agent_id,
    agent_key: agent.agent_key,
    agent_uid: uid,
    active_agent_version: activeVersion.version,
    system_prompt: activeVersion.system_prompt,
    behavior_policy: activeVersion.behavior_policy,
    model_policy: activeVersion.model_policy,
    context_policy: activeVersion.context_policy,
    tool_policy: activeVersion.tool_policy,
    learning_profile: learningProfile ?? null,
    runtime_profile_hash: `sha256:${profileHash}`,
  });
});

// POST /api/v1/learning-candidates
runtimeRoutes.post("/learning-candidates", async (req: Request, res: Response) => {
  const { capability_id, agent_id, agent_uid, source_type, source_id, session_id, candidates } = req.body;

  if (!capability_id || !agent_id || !agent_uid || !source_type || !candidates?.length) {
    throw new AppError("capability_id, agent_id, agent_uid, source_type, and candidates are required");
  }

  const agent = await queryOne("SELECT id FROM agent.agents WHERE agent_uid=$1", [agent_uid]);
  if (!agent) throw new AppError("Agent not found", 404);

  const inserted = [];
  for (const c of candidates) {
    const [row] = await query(
      `INSERT INTO agent.learning_candidates
         (agent_uid, capability_id, agent_id, source_type, source_id, session_id, candidate_type, content, confidence, importance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        agent_uid, capability_id, agent_id, source_type,
        source_id ?? null, session_id ?? null,
        c.candidate_type, c.content,
        c.confidence ?? 0.80, c.importance ?? 0.50,
      ]
    );
    inserted.push(row);
  }

  res.status(201).json({ submitted: inserted.length, candidates: inserted });
});

// GET /api/v1/learning-candidates?agent_uid=&status=
runtimeRoutes.get("/learning-candidates", async (req: Request, res: Response) => {
  const { agent_uid, status } = req.query;
  let sql = "SELECT * FROM agent.learning_candidates WHERE 1=1";
  const params: unknown[] = [];

  if (agent_uid) { params.push(agent_uid); sql += ` AND agent_uid=$${params.length}`; }
  if (status) { params.push(status); sql += ` AND status=$${params.length}`; }
  sql += " ORDER BY created_at DESC LIMIT 100";

  const candidates = await query(sql, params);
  res.json({ candidates });
});

// POST /api/v1/learning-candidates/:id/review
runtimeRoutes.post("/learning-candidates/:id/review", async (req: Request, res: Response) => {
  const { decision, review_note } = req.body;
  if (!["accepted", "rejected"].includes(decision)) throw new AppError("decision must be accepted or rejected");

  const [candidate] = await query(
    `UPDATE agent.learning_candidates
     SET status=$1, reviewed_by=$2, reviewed_at=now()
     WHERE id=$3 RETURNING *`,
    [decision, req.user?.user_id ?? null, req.params.id]
  );
  if (!candidate) throw new AppError("Candidate not found", 404);

  res.json({ ...candidate, review_note });
});
