import { Router, Request, Response } from "express";
import { query, queryOne } from "../database";
import { optionalAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";

export const toolRoutes = Router();
toolRoutes.use(optionalAuth);

// POST /api/v1/tools — register tool
toolRoutes.post("/", async (req: Request, res: Response) => {
  const {
    tool_name, version, display_name, description, risk_level,
    requires_approval, input_schema, output_schema, runtime,
    capabilities_required, allowed_capabilities, allowed_agents, tags, metadata,
  } = req.body;

  if (!tool_name || !display_name || !description || !input_schema || !runtime) {
    throw new AppError("tool_name, display_name, description, input_schema, and runtime are required");
  }

  const v = version ?? "1.0.0";
  const existing = await queryOne("SELECT id FROM tool.tools WHERE tool_name=$1 AND version=$2", [tool_name, v]);
  if (existing) throw new AppError(`Tool '${tool_name}@${v}' already registered`, 409);

  const [tool] = await query(
    `INSERT INTO tool.tools
       (tool_name, version, display_name, description, risk_level, requires_approval,
        input_schema, output_schema, runtime, capabilities_required,
        allowed_capabilities, allowed_agents, tags, metadata, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
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
      req.user?.user_id ?? null,
    ]
  );

  await query(
    `INSERT INTO tool.tool_audit_events (tool_name, tool_version, capability_id, agent_uid, event_type, payload)
     VALUES ($1,$2,$3,$4,'tool.registered',$5)`,
    [tool_name, v, null, null, JSON.stringify({ display_name })]
  );

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
