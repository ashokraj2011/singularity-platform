import { Router, Request, Response } from "express";
import { query, queryOne } from "../database";
import { optionalAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { publishEvent } from "../lib/eventbus/publisher";

export const toolRoutes = Router();
toolRoutes.use(optionalAuth);

// POST /api/v1/tools — register tool
toolRoutes.post("/", async (req: Request, res: Response) => {
  const {
    tool_name, version, display_name, description, risk_level,
    requires_approval, input_schema, output_schema, runtime,
    capabilities_required, allowed_capabilities, allowed_agents, tags, metadata,
    execution_target, mcp_server_ref,
  } = req.body;

  if (!tool_name || !display_name || !description || !input_schema || !runtime) {
    throw new AppError("tool_name, display_name, description, input_schema, and runtime are required");
  }
  if (execution_target && !["LOCAL", "SERVER"].includes(String(execution_target))) {
    throw new AppError("execution_target must be LOCAL or SERVER", 400);
  }

  const v = version ?? "1.0.0";
  const existing = await queryOne("SELECT id FROM tool.tools WHERE tool_name=$1 AND version=$2", [tool_name, v]);
  if (existing) throw new AppError(`Tool '${tool_name}@${v}' already registered`, 409);

  const [tool] = await query(
    `INSERT INTO tool.tools
       (tool_name, version, display_name, description, risk_level, requires_approval,
        input_schema, output_schema, runtime, capabilities_required,
        allowed_capabilities, allowed_agents, tags, metadata, execution_target, mcp_server_ref, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      tool_name, v, display_name, description,
      risk_level ?? "low", requires_approval ?? false,
      JSON.stringify(input_schema), JSON.stringify(output_schema ?? null),
      JSON.stringify(runtime),
      JSON.stringify(capabilities_required ?? {}),
      JSON.stringify(allowed_capabilities ?? []),
      JSON.stringify(allowed_agents ?? []),
      JSON.stringify(tags ?? []),
      JSON.stringify(metadata ?? {}),
      execution_target ?? "LOCAL",
      mcp_server_ref ?? null,
      req.user?.user_id ?? null,
    ]
  );

  await query(
    `INSERT INTO tool.tool_audit_events (tool_name, tool_version, capability_id, agent_uid, event_type, payload)
     VALUES ($1,$2,$3,$4,'tool.registered',$5)`,
    [tool_name, v, null, null, JSON.stringify({ display_name })]
  );

  // M11.e — emit canonical event so workgraph etc. can react.
  void publishEvent({
    eventName: "tool.registered",
    envelope: {
      source_service: "tool-service",
      subject: { kind: "tool", id: (tool as { id: string }).id },
      actor:   req.user?.user_id ? { kind: "user", id: req.user.user_id } : null,
      status:  "emitted",
      started_at: new Date().toISOString(),
      payload: {
        tool_name, version: v, display_name,
        risk_level: risk_level ?? "low",
        requires_approval: requires_approval ?? false,
      },
    },
  }).catch((err) => console.warn("[eventbus] publishEvent failed:", (err as Error).message));

  res.status(201).json(tool);
});

// GET /api/v1/tools
toolRoutes.get("/", async (req: Request, res: Response) => {
  const { status, capability_id, risk_level } = req.query;
  let sql = "SELECT * FROM tool.tools WHERE 1=1";
  const params: unknown[] = [];

  if (status) { params.push(status); sql += ` AND status=$${params.length}`; }
  if (risk_level) { params.push(risk_level); sql += ` AND risk_level=$${params.length}`; }
  if (capability_id) {
    params.push(`"${capability_id}"`);
    sql += ` AND allowed_capabilities @> $${params.length}::jsonb`;
  }
  sql += " ORDER BY created_at DESC";

  const tools = await query(sql, params);
  res.json({ tools });
});

// GET /api/v1/tools/:name/versions/:version
toolRoutes.get("/:name/versions/:version", async (req: Request, res: Response) => {
  const tool = await queryOne(
    "SELECT * FROM tool.tools WHERE tool_name=$1 AND version=$2",
    [req.params.name, req.params.version]
  );
  if (!tool) throw new AppError("Tool not found", 404);
  res.json(tool);
});

// PATCH /api/v1/tools/:name/versions/:version — partial update of editable
// fields. M20 ships requires_approval / status / risk_level; the rest stay
// register-time concerns.
toolRoutes.patch("/:name/versions/:version", async (req: Request, res: Response) => {
  const { name, version } = req.params;
  const ALLOWED: Record<string, "boolean" | "string"> = {
    requires_approval: "boolean",
    status:            "string",
    risk_level:        "string",
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, t] of Object.entries(ALLOWED)) {
    if (k in req.body) {
      const v = req.body[k];
      if (typeof v !== t) throw new AppError(`${k} must be ${t}`, 400);
      params.push(v);
      sets.push(`${k} = $${params.length}`);
    }
  }
  if (sets.length === 0) throw new AppError("no patchable fields in body", 400);
  sets.push(`updated_at = now()`);
  params.push(name, version);
  const updated = await queryOne(
    `UPDATE tool.tools SET ${sets.join(", ")}
     WHERE tool_name = $${params.length - 1} AND version = $${params.length}
     RETURNING *`,
    params,
  );
  if (!updated) throw new AppError("Tool not found", 404);
  await query(
    `INSERT INTO tool.tool_audit_events (tool_name, tool_version, event_type, payload)
     VALUES ($1,$2,'tool.updated',$3)`,
    [name, version, JSON.stringify({ patched: req.body, by: req.user?.user_id ?? null })],
  );
  res.json(updated);
});

// POST /api/v1/tools/:name/versions/:version/activate
toolRoutes.post("/:name/versions/:version/activate", async (req: Request, res: Response) => {
  const { name, version } = req.params;
  const tool = await queryOne(
    "SELECT * FROM tool.tools WHERE tool_name=$1 AND version=$2",
    [name, version]
  );
  if (!tool) throw new AppError("Tool not found", 404);

  const [activated] = await query(
    "UPDATE tool.tools SET status='active', approved_by=$1, approved_at=now(), updated_at=now() WHERE tool_name=$2 AND version=$3 RETURNING *",
    [req.user?.user_id ?? null, name, version]
  );

  await query(
    `INSERT INTO tool.tool_audit_events (tool_name, tool_version, event_type, payload)
     VALUES ($1,$2,'tool.activated',$3)`,
    [name, version, JSON.stringify({ approved_by: req.user?.user_id })]
  );

  res.json(activated);
});
