import { Router, Request, Response } from "express";
import { query, queryOne } from "../database";
import { optionalAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";

export const executionRoutes = Router();
executionRoutes.use(optionalAuth);

// POST /api/v1/tools/invoke
executionRoutes.post("/invoke", async (req: Request, res: Response) => {
  const {
    capability_id, agent_uid, agent_id, session_id, workflow_id, task_id,
    tool_name, tool_version, arguments: args, context_package_id, approval_id,
  } = req.body;

  if (!capability_id || !agent_uid || !tool_name) {
    throw new AppError("capability_id, agent_uid, and tool_name are required");
  }

  const version = tool_version ?? "1.0.0";
  const tool = await queryOne<Record<string, unknown>>(
    "SELECT * FROM tool.tools WHERE tool_name=$1 AND version=$2 AND status='active'",
    [tool_name, version]
  );

  if (!tool) {
    res.json({ status: "blocked", reason: "Tool not found or inactive" });
    return;
  }

  const caps = tool.allowed_capabilities as string[];
  if (caps.length > 0 && !caps.includes(capability_id)) {
    res.json({ status: "blocked", reason: "Capability not allowed for this tool" });
    return;
  }

  const agents = tool.allowed_agents as string[];
  if (agents.length > 0 && !agents.includes(agent_uid) && !agents.includes(`${capability_id}:${agent_id}`)) {
    res.json({ status: "blocked", reason: "Agent not allowed to use this tool" });
    return;
  }

  const risk = tool.risk_level as string;
  if ((risk === "high" || risk === "critical") && !approval_id) {
    res.json({
      status: "waiting_approval",
      reason: `Tool risk level is ${risk} and requires approval.`,
    });
    return;
  }

  const runtime = tool.runtime as Record<string, unknown>;
  const location = runtime.execution_location as string;

  // Create execution record
  const [execution] = await query(
    `INSERT INTO tool.tool_executions
       (tool_name, tool_version, capability_id, agent_uid, agent_id, session_id,
        workflow_id, task_id, execution_location, runtime_type, status, arguments_json,
        risk_level, requires_approval, context_package_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$13,$14)
     RETURNING id`,
    [
      tool_name, version, capability_id, agent_uid, agent_id ?? null,
      session_id ?? null, workflow_id ?? null, task_id ?? null,
      location, runtime.runtime_type,
      JSON.stringify(args ?? {}),
      risk, tool.requires_approval,
      context_package_id ?? null,
    ]
  );

  const execId = (execution as Record<string, unknown>).id as string;

  if (location === "client_local_runner") {
    // Create local runner job
    const [job] = await query(
      `INSERT INTO tool.client_execution_jobs (tool_execution_id, status, job_payload)
       VALUES ($1,'pending',$2) RETURNING id`,
      [execId, JSON.stringify({ tool_name, version, arguments: args, runtime })]
    );

    await query(
      "UPDATE tool.tool_executions SET status='client_execution_required' WHERE id=$1",
      [execId]
    );

    res.json({
      status: "client_execution_required",
      tool_execution_id: execId,
      client_job_id: (job as Record<string, unknown>).id,
      execution_location: "client_local_runner",
      message: "Waiting for local runner.",
    });
    return;
  }

  if (location === "server") {
    // Execute HTTP server tool
    const endpointUrl = runtime.endpoint_url as string | undefined;
    if (!endpointUrl) {
      await query("UPDATE tool.tool_executions SET status='error', error=$1, completed_at=now() WHERE id=$2", [
        "No endpoint_url configured", execId,
      ]);
      res.json({ status: "error", tool_execution_id: execId, error: "No endpoint_url configured for server tool" });
      return;
    }

    try {
      const method = (runtime.method as string | undefined) ?? "POST";
      const response = await fetch(endpointUrl, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      const output = await response.json() as Record<string, unknown>;

      await query(
        "UPDATE tool.tool_executions SET status='success', output_json=$1, completed_at=now() WHERE id=$2",
        [JSON.stringify(output), execId]
      );

      res.json({ status: "success", tool_execution_id: execId, tool_name, output });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await query("UPDATE tool.tool_executions SET status='error', error=$1, completed_at=now() WHERE id=$2", [msg, execId]);
      res.json({ status: "error", tool_execution_id: execId, error: msg });
    }
    return;
  }

  if (location === "browser") {
    await query("UPDATE tool.tool_executions SET status='browser_execution_required' WHERE id=$1", [execId]);
    res.json({
      status: "browser_execution_required",
      tool_execution_id: execId,
      runtime,
      arguments: args,
    });
    return;
  }

  res.json({ status: "blocked", reason: `Unsupported execution location: ${location}` });
});

// GET /api/v1/tools/executions
executionRoutes.get("/executions", async (req: Request, res: Response) => {
  const { capability_id, agent_uid, tool_name } = req.query;
  let sql = "SELECT * FROM tool.tool_executions WHERE 1=1";
  const params: unknown[] = [];

  if (capability_id) { params.push(capability_id); sql += ` AND capability_id=$${params.length}`; }
  if (agent_uid) { params.push(agent_uid); sql += ` AND agent_uid=$${params.length}`; }
  if (tool_name) { params.push(tool_name); sql += ` AND tool_name=$${params.length}`; }
  sql += " ORDER BY started_at DESC LIMIT 100";

  const executions = await query(sql, params);
  res.json({ executions });
});
