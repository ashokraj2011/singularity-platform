/**
 * M19 — connector tool wrappers.
 *
 * Workgraph already has a connector adapter system (Slack, Email, Teams,
 * Jira, Datadog, ServiceNow, Confluence, GitHub, S3, Postgres, HTTP) with
 * a uniform `POST /api/connectors/:id/invoke {operation, params}` interface.
 * This router exposes a typed tool surface so the LLM can call them by
 * connector *name* (not UUID — agents don't know UUIDs) + operation.
 *
 * Generic entry point:
 *   POST /api/v1/connector-tools/connector_invoke
 *     { connector_name, operation, params }
 *
 * Typed convenience wrappers (just rewrite to connector_invoke under the hood):
 *   send_slack_message        → SLACK + sendMessage
 *   send_email                → EMAIL + sendMail
 *   send_teams_message        → TEAMS + sendMessage
 *   create_jira_issue         → JIRA + createIssue
 *
 * Authorization: workgraph requires its own bearer. The token is configured
 * via WORKGRAPH_API_BEARER env (operator-managed; same shape as
 * IAM_SERVICE_TOKEN for cross-service calls).
 */
import { Router, Request, Response } from "express";

const WORKGRAPH_API_URL    = process.env.WORKGRAPH_API_URL ?? "http://host.docker.internal:8080";
const WORKGRAPH_API_BEARER = process.env.WORKGRAPH_API_BEARER ?? "";

interface ConnectorRow {
  id: string;
  name: string;
  type: string;
  archivedAt?: string | null;
}

async function findConnectorByName(name: string, expectedType?: string): Promise<ConnectorRow> {
  const url = `${WORKGRAPH_API_URL.replace(/\/$/, "")}/api/connectors`;
  const res = await fetch(url, {
    headers: WORKGRAPH_API_BEARER ? { authorization: `Bearer ${WORKGRAPH_API_BEARER}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`workgraph /api/connectors ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const all = (await res.json()) as ConnectorRow[];
  const match = all.find((c) => !c.archivedAt && c.name === name && (!expectedType || c.type === expectedType));
  if (!match) {
    const expected = expectedType ? ` of type ${expectedType}` : "";
    throw new Error(`connector named '${name}'${expected} not found (available: ${all.filter((c) => !c.archivedAt).map((c) => `${c.name}/${c.type}`).join(", ")})`);
  }
  return match;
}

async function invokeConnector(connectorId: string, operation: string, params: Record<string, unknown>): Promise<unknown> {
  const url = `${WORKGRAPH_API_URL.replace(/\/$/, "")}/api/connectors/${connectorId}/invoke`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(WORKGRAPH_API_BEARER ? { authorization: `Bearer ${WORKGRAPH_API_BEARER}` } : {}),
    },
    body: JSON.stringify({ operation, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`workgraph connector invoke ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return { result: text }; }
}

export const connectorToolsRoutes = Router();

// Generic — agent provides connector_name + operation explicitly.
connectorToolsRoutes.post("/connector_invoke", async (req: Request, res: Response) => {
  const { connector_name, operation, params } = req.body ?? {};
  if (!connector_name || !operation) {
    return res.status(400).json({ error: "connector_name + operation required" });
  }
  try {
    const c = await findConnectorByName(String(connector_name));
    const result = await invokeConnector(c.id, String(operation), (params as Record<string, unknown>) ?? {});
    res.json({ connector: { id: c.id, name: c.name, type: c.type }, operation, result });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// ── Typed convenience wrappers ──────────────────────────────────────────────

function typedHandler(connectorType: string, operation: string, defaultName: string) {
  return async (req: Request, res: Response) => {
    const { connector_name, ...params } = req.body ?? {};
    const name = (typeof connector_name === "string" && connector_name) ? connector_name : defaultName;
    try {
      const c = await findConnectorByName(name, connectorType);
      const result = await invokeConnector(c.id, operation, params as Record<string, unknown>);
      res.json({ connector: { id: c.id, name: c.name, type: c.type }, operation, result });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  };
}

connectorToolsRoutes.post("/send_slack_message", typedHandler("SLACK",  "sendMessage", "default-slack"));
connectorToolsRoutes.post("/send_email",         typedHandler("EMAIL",  "sendMail",    "default-email"));
connectorToolsRoutes.post("/send_teams_message", typedHandler("TEAMS",  "sendMessage", "default-teams"));
connectorToolsRoutes.post("/create_jira_issue",  typedHandler("JIRA",   "createIssue", "default-jira"));
