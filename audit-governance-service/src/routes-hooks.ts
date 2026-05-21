import { Router, Request, Response } from "express";
import { z } from "zod";
import { query } from "./db";
import { requireServiceAuth } from "./routes-events";

export const hooksRouter = Router();

const bodySchema = z.record(z.unknown()).default({});

const EVENT_KIND: Record<string, string> = {
  pretooluse: "copilot.pretooluse",
  pre_tool_use: "copilot.pretooluse",
  "pre-tool-use": "copilot.pretooluse",
  posttooluse: "copilot.posttooluse",
  post_tool_use: "copilot.posttooluse",
  "post-tool-use": "copilot.posttooluse",
  stop: "copilot.stop",
  subagentstart: "copilot.subagent.start",
  subagent_start: "copilot.subagent.start",
  "subagent-start": "copilot.subagent.start",
  subagentstop: "copilot.subagent.stop",
  subagent_stop: "copilot.subagent.stop",
  "subagent-stop": "copilot.subagent.stop",
}

function normalizeEventName(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/[.\s]/g, "_");
  return EVENT_KIND[key] ?? `copilot.${key.replace(/_/g, ".")}`;
}

function stringFrom(body: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

hooksRouter.use(requireServiceAuth);

hooksRouter.post("/:invocationId/:eventName", async (req: Request, res: Response) => {
  const invocationId = String(req.params.invocationId);
  const body = bodySchema.parse(req.body ?? {});
  const kind = normalizeEventName(String(req.params.eventName));
  const traceId = stringFrom(body, ["traceId", "trace_id"]) ?? `laptop-${invocationId}`;
  const capabilityId = stringFrom(body, ["capabilityId", "capability_id"]);
  const tenantId = stringFrom(body, ["tenantId", "tenant_id"]);
  const actorId = stringFrom(body, ["actorId", "actor_id", "userId", "user_id"]);

  const rows = await query<{ id: string }>(
    `INSERT INTO audit_governance.audit_events
       (trace_id, source_service, kind, subject_type, subject_id,
        actor_id, capability_id, tenant_id, severity, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     RETURNING id`,
    [
      traceId,
      "copilot-laptop",
      kind,
      "LaptopInvocation",
      invocationId,
      actorId,
      capabilityId,
      tenantId,
      kind === "copilot.pretooluse" ? "info" : "info",
      JSON.stringify({
        invocationId,
        eventName: req.params.eventName,
        receivedAt: new Date().toISOString(),
        ...body,
      }),
    ],
  );

  const toolName = stringFrom(body, ["tool", "toolName", "tool_name"]);
  const readOnlyTool = !toolName || /^(read|list|search|grep|glob|status|diff)/i.test(toolName);
  res.status(201).json({
    ok: true,
    id: rows[0].id,
    kind,
    decision: kind === "copilot.pretooluse" ? (readOnlyTool ? "allow" : "record_and_continue") : undefined,
  });
});
