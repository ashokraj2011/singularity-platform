import { Router, Request, Response } from "express";
import { query, queryOne } from "../database";
import { optionalAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";

export const learningRoutes = Router();
learningRoutes.use(optionalAuth);

// POST /api/v1/agents (learning-candidates at top level — mounted via separate route below)
// Candidates route is mounted at /api/v1 separately — see index.ts note.
// These routes handle profile versioning under /:uid/learning-profiles.

// GET /api/v1/agents/:uid/learning-profiles/:profileType/versions
learningRoutes.get("/:uid/learning-profiles/:profileType/versions", async (req: Request, res: Response) => {
  const { uid, profileType } = req.params;
  const versions = await query(
    `SELECT id, agent_uid, profile_type, version, status, summary_text, change_reason, created_at
     FROM agent.agent_learning_profiles
     WHERE agent_uid=$1 AND profile_type=$2
     ORDER BY version DESC`,
    [uid, profileType]
  );
  res.json({ versions });
});

// POST /api/v1/agents/:uid/learning-profiles/:profileType/versions
learningRoutes.post("/:uid/learning-profiles/:profileType/versions", async (req: Request, res: Response) => {
  const { uid, profileType } = req.params;
  const { summary, summary_text, source_candidate_ids, change_reason } = req.body;

  if (!summary) throw new AppError("summary is required");

  const agent = await queryOne("SELECT agent_uid FROM agent.agents WHERE agent_uid=$1", [uid]);
  if (!agent) throw new AppError("Agent not found", 404);

  const last = await queryOne<{ version: number }>(
    "SELECT COALESCE(MAX(version),0) as version FROM agent.agent_learning_profiles WHERE agent_uid=$1 AND profile_type=$2",
    [uid, profileType]
  );
  const nextVersion = (last?.version ?? 0) + 1;

  // Deactivate previous active profile
  await query(
    "UPDATE agent.agent_learning_profiles SET status='archived' WHERE agent_uid=$1 AND profile_type=$2 AND status='active'",
    [uid, profileType]
  );

  const [profile] = await query(
    `INSERT INTO agent.agent_learning_profiles
       (agent_uid, profile_type, version, status, summary, summary_text, source_memory_item_ids, change_reason, created_by)
     VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      uid, profileType, nextVersion,
      JSON.stringify(summary), summary_text ?? null,
      JSON.stringify(source_candidate_ids ?? []),
      change_reason ?? null, req.user?.user_id ?? null,
    ]
  );

  res.status(201).json(profile);
});

// POST /api/v1/agents/:uid/learning-profiles/:profileType/rollback
learningRoutes.post("/:uid/learning-profiles/:profileType/rollback", async (req: Request, res: Response) => {
  const { uid, profileType } = req.params;
  const { target_version, reason } = req.body;

  if (!target_version) throw new AppError("target_version is required");

  const target = await queryOne(
    "SELECT * FROM agent.agent_learning_profiles WHERE agent_uid=$1 AND profile_type=$2 AND version=$3",
    [uid, profileType, target_version]
  );
  if (!target) throw new AppError("Target version not found", 404);

  const last = await queryOne<{ version: number }>(
    "SELECT COALESCE(MAX(version),0) as version FROM agent.agent_learning_profiles WHERE agent_uid=$1 AND profile_type=$2",
    [uid, profileType]
  );
  const nextVersion = (last?.version ?? 0) + 1;

  const t = target as Record<string, unknown>;
  await query(
    "UPDATE agent.agent_learning_profiles SET status='archived' WHERE agent_uid=$1 AND profile_type=$2 AND status='active'",
    [uid, profileType]
  );

  const [newProfile] = await query(
    `INSERT INTO agent.agent_learning_profiles
       (agent_uid, profile_type, version, status, summary, summary_text, change_reason, created_by)
     VALUES ($1,$2,$3,'active',$4,$5,$6,$7)
     RETURNING *`,
    [uid, profileType, nextVersion, t.summary, t.summary_text, `Rollback to v${target_version}: ${reason ?? ""}`, req.user?.user_id ?? null]
  );

  res.status(201).json(newProfile);
});
