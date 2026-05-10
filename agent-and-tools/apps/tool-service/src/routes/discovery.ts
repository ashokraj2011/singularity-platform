import { Router, Request, Response } from "express";
import { query } from "../database";
import { optionalAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";

export const discoveryRoutes = Router();
discoveryRoutes.use(optionalAuth);

const RISK_ORDER = ["low", "medium", "high", "critical"];

function rankTools(tools: Record<string, unknown>[], queryStr: string, taskType: string): Record<string, unknown>[] {
  return tools
    .map((t) => {
      let score = 0;
      const name = (t.tool_name as string).toLowerCase();
      const desc = (t.description as string).toLowerCase();
      const tags = t.tags as string[];
      const q = queryStr.toLowerCase();

      if (name.includes(q)) score += 10;
      if (desc.includes(q)) score += 5;
      if (tags.some((tag) => tag.includes(q))) score += 3;

      // Prefer code tools for code tasks
      if (taskType === "code_question" && name.startsWith("code.")) score += 8;
      if (t.risk_level === "low") score += 2;

      return { ...t, _score: score };
    })
    .sort((a, b) => (b._score as number) - (a._score as number))
    .map(({ _score, ...t }) => t);
}

// POST /api/v1/tools/discover
discoveryRoutes.post("/discover", async (req: Request, res: Response) => {
  const { capability_id, agent_uid, agent_id, task_type, query: q, risk_max, limit } = req.body;

  if (!capability_id || !agent_uid) throw new AppError("capability_id and agent_uid are required");

  const maxRiskIndex = RISK_ORDER.indexOf(risk_max ?? "medium");
  const allowedRisks = RISK_ORDER.slice(0, maxRiskIndex + 1);

  const allTools = await query(
    `SELECT tool_name, version, description, display_name, input_schema, risk_level,
            requires_approval, execution_target, mcp_server_ref,
            runtime, tags, allowed_capabilities, allowed_agents
     FROM tool.tools
     WHERE status='active'`
  );

  const filtered = allTools.filter((t) => {
    const caps = t.allowed_capabilities as string[];
    const agents = t.allowed_agents as string[];
    const risk = t.risk_level as string;

    const capOk = caps.length === 0 || caps.includes(capability_id);
    const agentOk = agents.length === 0 || agents.includes(agent_uid) || agents.includes(`${capability_id}:${agent_id}`);
    const riskOk = allowedRisks.includes(risk);

    return capOk && agentOk && riskOk;
  });

  const ranked = rankTools(filtered, q ?? "", task_type ?? "");
  const results = ranked.slice(0, limit ?? 8).map((t) => {
    const runtime = t.runtime as Record<string, unknown>;
    return {
      tool_name: t.tool_name,
      version: t.version,
      description: t.description,
      input_schema: t.input_schema,
      risk_level: t.risk_level,
      requires_approval: t.requires_approval ?? false,
      execution_target: t.execution_target ?? "LOCAL",
      mcp_server_ref: t.mcp_server_ref ?? null,
      execution_location: runtime.execution_location,
      runtime_type: runtime.runtime_type,
    };
  });

  res.json({ tools: results });
});
