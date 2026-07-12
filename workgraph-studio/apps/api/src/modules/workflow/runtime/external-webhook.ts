/**
 * EXTERNAL-location webhook dispatch.
 *
 * For a node with executionLocation=EXTERNAL and a `webhookUrl` in its config, the
 * server POSTs the job to the provider and takes the result from the HTTP response
 * (synchronous). No bearer-less callback endpoint is introduced — the provider does
 * the work and answers in the response; WorkflowRuntime maps that to complete+advance
 * (or failNode). A node with no webhookUrl is left on the queue for a poll-runner.
 *
 * SECURITY — this is an OUTBOUND call to a config-supplied URL, so it is SSRF-guarded
 * with the INVERSE of the internal api-caller guard: only PUBLIC addresses are
 * allowed; loopback / private / link-local (incl. 169.254.169.254 cloud metadata) /
 * unique-local are refused. An optional `webhookSecret` HMAC-signs the body so the
 * provider can verify authenticity.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { createHmac } from "node:crypto";
import net from "node:net";
import { classifyAddress } from "../../../lib/ssrf-guard";

export type ExternalWebhookOutcome =
  | { kind: "result"; result: unknown }
  | { kind: "error"; error: string }
  | { kind: "skipped" };

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

// webhookUrl / webhookSecret may sit at the top level or under the designer's
// `standard` sub-object.
function cfgString(config: Record<string, unknown>, key: string): string | undefined {
  const direct = config[key];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const standard = isRecord(config.standard) ? config.standard : {};
  const nested = standard[key];
  return typeof nested === "string" && nested.trim() ? nested.trim() : undefined;
}

export function externalWebhookUrl(config: unknown): string | undefined {
  return isRecord(config) ? cfgString(config, "webhookUrl") : undefined;
}

// Allow ONLY public destinations (inverse of the internal-only ssrf guard). Resolve
// every address for a hostname and require all of them public, so a host that returns
// one public + one private address is refused. Exported for unit tests (IP-literal
// cases resolve synchronously, no DNS).
export async function guardExternalWebhookUrl(rawUrl: string): Promise<{ ok: true; url: URL } | { ok: false; reason: string }> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { ok: false, reason: "invalid URL" }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `protocol ${url.protocol} not allowed (http/https only)` };
  }
  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!host) return { ok: false, reason: "missing host" };
  const ipLiteral = net.isIP(host) ? host : null;
  if (ipLiteral) {
    return classifyAddress(ipLiteral) === "public"
      ? { ok: true, url }
      : { ok: false, reason: `target IP ${ipLiteral} is not a public address` };
  }
  let addrs: { address: string }[];
  try {
    addrs = await dnsLookup(host, { all: true });
  } catch (err) {
    return { ok: false, reason: `could not resolve host '${host}': ${(err as Error).message}` };
  }
  if (addrs.length === 0) return { ok: false, reason: `host '${host}' resolved to no addresses` };
  for (const a of addrs) {
    if (classifyAddress(a.address) !== "public") {
      return { ok: false, reason: `host '${host}' resolves to non-public address ${a.address}` };
    }
  }
  return { ok: true, url };
}

export async function dispatchExternalWebhook(args: {
  node: { id: string; nodeType: string; config: unknown };
  instanceId: string;
  pendingExecutionId: string;
  context: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<ExternalWebhookOutcome> {
  const config = isRecord(args.node.config) ? args.node.config : {};
  const url = cfgString(config, "webhookUrl");
  if (!url) return { kind: "skipped" }; // no webhook → leave on the queue for a poll-runner

  const guard = await guardExternalWebhookUrl(url);
  if (!guard.ok) return { kind: "error", error: `external webhook refused: ${guard.reason}` };

  const timeoutMs = Math.min(Math.max(args.timeoutMs ?? 30_000, 1_000), 300_000);
  const payload = {
    pendingExecutionId: args.pendingExecutionId,
    nodeId: args.node.id,
    instanceId: args.instanceId,
    nodeType: args.node.nodeType,
    config,
    context: args.context,
  };
  const bodyText = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "singularity-workflow-webhook",
  };
  const secret = cfgString(config, "webhookSecret");
  if (secret) {
    headers["x-signature-256"] = `sha256=${createHmac("sha256", secret).update(bodyText).digest("hex")}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(guard.url.toString(), { method: "POST", headers, body: bodyText, signal: controller.signal });
  } catch (err) {
    return { kind: "error", error: `external webhook POST failed: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }

  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    return { kind: "error", error: `external webhook returned HTTP ${resp.status}${text ? `: ${text.slice(0, 300)}` : ""}` };
  }
  let parsed: unknown = undefined;
  if (text.trim()) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  // Accept { result: … } or a bare body as the node's result.
  const result = isRecord(parsed) && "result" in parsed ? parsed.result : parsed;
  return { kind: "result", result: result ?? {} };
}
