import { isIP } from "node:net";
import { z } from "zod";
import { boundedEnvInteger } from "./env";
import { query, queryOne } from "./db";
import { getLogStorage, type StoredLogInput } from "./log-storage";

const RETENTION_DAYS = boundedEnvInteger("LOG_RETENTION_DAYS", { defaultValue: 30, min: 1, max: 3_650 });
const RETENTION_BATCH = boundedEnvInteger("LOG_RETENTION_DELETE_BATCH", { defaultValue: 10_000, min: 100, max: 100_000 });
const EXPORT_MAX_ATTEMPTS = boundedEnvInteger("LOG_EXPORT_MAX_ATTEMPTS", { defaultValue: 8, min: 1, max: 50 });
const EXPORT_TIMEOUT_MS = boundedEnvInteger("LOG_EXPORT_TIMEOUT_MS", { defaultValue: 10_000, min: 500, max: 120_000 });
const EXPORT_WORKER_SEC = boundedEnvInteger("LOG_EXPORT_WORKER_SEC", { defaultValue: 15, min: 5, max: 300 });
const ALERT_EVAL_SEC = boundedEnvInteger("LOG_ALERT_EVAL_SEC", { defaultValue: 60, min: 30, max: 3_600 });
const RETENTION_SWEEP_SEC = boundedEnvInteger("LOG_RETENTION_SWEEP_SEC", { defaultValue: 3_600, min: 60, max: 86_400 });

const EnvNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(120);
const ExportTargetSchema = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_.:-]+$/),
  type: z.enum(["datadog", "splunk", "http-json"]),
  url: z.string().url().max(1_000),
  credentialEnv: EnvNameSchema.optional(),
  enabled: z.boolean().default(true),
});

export const LogAlertRuleInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  service: z.string().trim().min(1).max(120).nullable().optional(),
  windowMinutes: z.number().int().min(1).max(1_440).default(15),
  minimumEvents: z.number().int().min(1).max(1_000_000).default(20),
  errorRateThreshold: z.number().min(0).max(1).default(0.05),
  maxSilenceMinutes: z.number().int().min(1).max(43_200).nullable().optional(),
  exportTargetId: z.string().trim().max(80).nullable().optional(),
  enabled: z.boolean().default(true),
});

export type LogExportTarget = z.infer<typeof ExportTargetSchema> & {
  ready: boolean;
  warning?: string;
};

type RetentionStorageResult = {
  managed: boolean;
  deletedPartitions: number;
  note?: string;
};

type AlertRuleRow = {
  id: string;
  name: string;
  service: string | null;
  window_minutes: number;
  minimum_events: number;
  error_rate_threshold: number;
  max_silence_minutes: number | null;
  export_target_id: string | null;
  enabled: boolean;
};

let exportTimer: NodeJS.Timeout | null = null;
let alertTimer: NodeJS.Timeout | null = null;
let retentionTimer: NodeJS.Timeout | null = null;
let exportSweepActive = false;
let alertSweepActive = false;
let retentionSweepActive = false;

function truthy(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] ?? "").toLowerCase());
}

function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return isIP(host) === 6 && (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80"));
}

function validateTarget(target: z.infer<typeof ExportTargetSchema>): string | undefined {
  const url = new URL(target.url);
  if (!['https:', 'http:'].includes(url.protocol)) return "Only HTTP(S) export targets are supported.";
  if (url.protocol === "http:" && !truthy("LOG_EXPORT_ALLOW_INSECURE_HTTP")) return "HTTP export target requires LOG_EXPORT_ALLOW_INSECURE_HTTP=true.";
  if (privateHost(url.hostname) && !truthy("LOG_EXPORT_ALLOW_PRIVATE_URLS")) return "Private/local export target requires LOG_EXPORT_ALLOW_PRIVATE_URLS=true.";
  if (["datadog", "splunk"].includes(target.type) && !target.credentialEnv) return `${target.type} target requires credentialEnv.`;
  if (target.credentialEnv && !process.env[target.credentialEnv]?.trim()) return `${target.credentialEnv} is not configured in the audit-governance environment.`;
  return undefined;
}

export function logExportTargets(): LogExportTarget[] {
  const raw = process.env.LOG_EXPORT_TARGETS_JSON?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) {
    return [{ id: "invalid-config", type: "http-json", url: "https://invalid.example", enabled: false, ready: false, warning: `LOG_EXPORT_TARGETS_JSON is invalid JSON: ${(error as Error).message}` }];
  }
  const result = z.array(ExportTargetSchema).safeParse(parsed);
  if (!result.success) {
    return [{ id: "invalid-config", type: "http-json", url: "https://invalid.example", enabled: false, ready: false, warning: result.error.issues.map((issue) => issue.message).join("; ") }];
  }
  return result.data.map((target) => {
    const warning = validateTarget(target);
    return { ...target, ready: target.enabled && !warning, ...(warning ? { warning } : {}) };
  });
}

function safeExportRecords(records: StoredLogInput[]): StoredLogInput[] {
  return records.slice(0, 500).map((record) => ({
    ...record,
    message: String(record.message ?? "").slice(0, 8_000),
    payload: (() => {
      const payload = record.payload ?? {};
      const serialized = JSON.stringify(payload);
      return Buffer.byteLength(serialized, "utf8") <= 128_000
        ? payload
        : { _truncated: true, _originalBytes: Buffer.byteLength(serialized, "utf8") };
    })(),
  }));
}

export async function queueLogExports(records: StoredLogInput[], onlyTargetId?: string | null): Promise<number> {
  if (records.length === 0) return 0;
  const targets = logExportTargets().filter((target) => target.ready && (!onlyTargetId || target.id === onlyTargetId));
  const payload = JSON.stringify({ logs: safeExportRecords(records) });
  for (const target of targets) {
    await query(
      `INSERT INTO audit_governance.observability_log_export_queue(target_id, payload)
       VALUES ($1, $2::jsonb)`,
      [target.id, payload],
    );
  }
  return targets.length;
}

function targetHeaders(target: LogExportTarget): Record<string, string> {
  const credential = target.credentialEnv ? process.env[target.credentialEnv]?.trim() : undefined;
  if (target.type === "datadog") return { "content-type": "application/json", "DD-API-KEY": credential ?? "" };
  if (target.type === "splunk") return { "content-type": "application/json", authorization: `Splunk ${credential ?? ""}` };
  return { "content-type": "application/json", ...(credential ? { authorization: `Bearer ${credential}` } : {}) };
}

function targetBody(target: LogExportTarget, records: StoredLogInput[]): string {
  if (target.type === "datadog") {
    return JSON.stringify(records.map((record) => ({
      ...record,
      ddsource: "singularity",
      status: record.level,
      timestamp: Number.isNaN(Date.parse(String(record.ts))) ? Date.now() : Date.parse(String(record.ts)),
    })));
  }
  if (target.type === "splunk") {
    return records.map((record) => JSON.stringify({
      time: Number.isNaN(Date.parse(String(record.ts))) ? Date.now() / 1_000 : Date.parse(String(record.ts)) / 1_000,
      host: record.host,
      source: record.service,
      sourcetype: "_json",
      event: record,
    })).join("\n");
  }
  return JSON.stringify({ logs: records });
}

async function deliverExport(target: LogExportTarget, records: StoredLogInput[]): Promise<void> {
  const response = await fetch(target.url, {
    method: "POST",
    headers: targetHeaders(target),
    body: targetBody(target, records),
    redirect: "error",
    signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`export target ${target.id} returned HTTP ${response.status}: ${detail.slice(0, 300)}`);
  }
}

export async function processLogExportQueue(): Promise<{ delivered: number; failed: number }> {
  if (exportSweepActive) return { delivered: 0, failed: 0 };
  exportSweepActive = true;
  let delivered = 0;
  let failed = 0;
  try {
    const targets = new Map(logExportTargets().map((target) => [target.id, target]));
    const rows = await query<{ id: string; target_id: string; payload: { logs?: StoredLogInput[] }; attempts: number }>(
      `SELECT id, target_id, payload, attempts
         FROM audit_governance.observability_log_export_queue
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY created_at ASC
        LIMIT 50`,
    );
    for (const row of rows) {
      const target = targets.get(row.target_id);
      const records = Array.isArray(row.payload?.logs) ? row.payload.logs : [];
      try {
        if (!target?.ready) throw new Error(target?.warning ?? `export target ${row.target_id} is missing or disabled`);
        await deliverExport(target, records);
        await query(
          `UPDATE audit_governance.observability_log_export_queue
              SET status='delivered', attempts=attempts+1, delivered_at=now(), last_error=NULL
            WHERE id=$1`,
          [row.id],
        );
        delivered += 1;
      } catch (error) {
        const attempts = row.attempts + 1;
        const terminal = attempts >= EXPORT_MAX_ATTEMPTS;
        const delaySeconds = Math.min(3_600, 5 * (2 ** Math.min(attempts, 10)));
        await query(
          `UPDATE audit_governance.observability_log_export_queue
              SET status=$2, attempts=$3, last_error=$4,
                  next_attempt_at=now() + make_interval(secs => $5)
            WHERE id=$1`,
          [row.id, terminal ? "failed" : "pending", attempts, (error as Error).message.slice(0, 1_000), delaySeconds],
        );
        failed += 1;
      }
    }
    return { delivered, failed };
  } finally {
    exportSweepActive = false;
  }
}

export async function runLogRetentionSweep(): Promise<{ cutoff: string; deletedRows: number; storage: RetentionStorageResult }> {
  if (retentionSweepActive) return { cutoff: new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString(), deletedRows: 0, storage: { managed: true, deletedPartitions: 0, note: "sweep already running" } };
  retentionSweepActive = true;
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
  let deletedRows = 0;
  try {
    while (true) {
      const deleted = await query<{ id: string }>(
        `WITH doomed AS (
           SELECT ctid FROM audit_governance.observability_logs WHERE ts < $1 ORDER BY ts ASC LIMIT $2
         )
         DELETE FROM audit_governance.observability_logs logs
          USING doomed
          WHERE logs.ctid = doomed.ctid
          RETURNING logs.id`,
        [cutoff.toISOString(), RETENTION_BATCH],
      );
      deletedRows += deleted.length;
      if (deleted.length < RETENTION_BATCH) break;
    }
    const storage = await getLogStorage().pruneBefore(cutoff);
    return { cutoff: cutoff.toISOString(), deletedRows, storage };
  } finally {
    retentionSweepActive = false;
  }
}

export async function ensureDefaultLogAlertRule(): Promise<void> {
  if (["0", "false", "no", "off"].includes(String(process.env.LOG_DEFAULT_SLO_ENABLED ?? "true").toLowerCase())) return;
  const windowMinutes = boundedEnvInteger("LOG_DEFAULT_SLO_WINDOW_MINUTES", { defaultValue: 15, min: 1, max: 1_440 });
  const minimumEvents = boundedEnvInteger("LOG_DEFAULT_SLO_MINIMUM_EVENTS", { defaultValue: 20, min: 1, max: 1_000_000 });
  const threshold = Math.max(0, Math.min(1, Number(process.env.LOG_DEFAULT_SLO_ERROR_RATE ?? "0.05") || 0.05));
  await query(
    `INSERT INTO audit_governance.observability_alert_rules(name, window_minutes, minimum_events, error_rate_threshold, max_silence_minutes)
     VALUES ('Platform error-rate SLO', $1, $2, $3, NULL)
     ON CONFLICT (name) DO NOTHING`,
    [windowMinutes, minimumEvents, threshold],
  );
}

export async function evaluateLogAlerts(): Promise<Array<Record<string, unknown>>> {
  if (alertSweepActive) return [];
  alertSweepActive = true;
  try {
    const rules = await query<AlertRuleRow>(
      `SELECT id, name, service, window_minutes, minimum_events, error_rate_threshold,
              max_silence_minutes, export_target_id, enabled
         FROM audit_governance.observability_alert_rules
        WHERE enabled=true ORDER BY name ASC`,
    );
    const evaluations: Array<Record<string, unknown>> = [];
    for (const rule of rules) {
      const stats = await queryOne<{ total: number; errors: number; newest_at: Date | null }>(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE level IN ('error','fatal'))::int AS errors,
           MAX(ts) AS newest_at
         FROM audit_governance.observability_logs
         WHERE ts >= now() - make_interval(mins => $1)
           AND ($2::text IS NULL OR service = $2)`,
        [rule.window_minutes, rule.service],
      );
      const total = stats?.total ?? 0;
      const errors = stats?.errors ?? 0;
      const errorRate = total > 0 ? errors / total : 0;
      const newestAt = stats?.newest_at ? new Date(stats.newest_at) : null;
      const silentMinutes = newestAt ? (Date.now() - newestAt.getTime()) / 60_000 : Number.POSITIVE_INFINITY;
      const reasons: string[] = [];
      if (total >= rule.minimum_events && errorRate > rule.error_rate_threshold) {
        reasons.push(`error rate ${(errorRate * 100).toFixed(2)}% exceeds ${(rule.error_rate_threshold * 100).toFixed(2)}%`);
      }
      if (rule.max_silence_minutes && silentMinutes > rule.max_silence_minutes) {
        reasons.push(`no logs for ${Number.isFinite(silentMinutes) ? Math.floor(silentMinutes) : "any"} minutes`);
      }
      const observed = { total, errors, errorRate, newestAt: newestAt?.toISOString() ?? null, windowMinutes: rule.window_minutes, service: rule.service };
      const open = await queryOne<{ id: string; status: string }>(
        `SELECT id, status FROM audit_governance.observability_alert_incidents
          WHERE rule_id=$1 AND status IN ('open','acknowledged') LIMIT 1`,
        [rule.id],
      );
      if (reasons.length > 0) {
        let incidentId = open?.id;
        if (open) {
          await query(
            `UPDATE audit_governance.observability_alert_incidents
                SET reason=$2, observed=$3::jsonb, last_seen_at=now()
              WHERE id=$1`,
            [open.id, reasons.join("; "), JSON.stringify(observed)],
          );
        } else {
          const incident = await queryOne<{ id: string }>(
            `INSERT INTO audit_governance.observability_alert_incidents(rule_id, reason, observed)
             VALUES ($1,$2,$3::jsonb) RETURNING id`,
            [rule.id, reasons.join("; "), JSON.stringify(observed)],
          );
          incidentId = incident?.id;
          if (rule.export_target_id) {
            await queueLogExports([{
              ts: new Date().toISOString(), service: "audit-governance", level: "error",
              eventType: "observability.slo.violated", message: `${rule.name}: ${reasons.join("; ")}`,
              payload: { ruleId: rule.id, incidentId, observed },
            }], rule.export_target_id);
          }
        }
        evaluations.push({ ruleId: rule.id, name: rule.name, status: "violated", incidentId, reasons, observed });
      } else {
        if (open) {
          await query(
            `UPDATE audit_governance.observability_alert_incidents
                SET status='resolved', resolved_at=now(), last_seen_at=now(), observed=$2::jsonb
              WHERE id=$1`,
            [open.id, JSON.stringify(observed)],
          );
        }
        evaluations.push({ ruleId: rule.id, name: rule.name, status: "healthy", observed });
      }
    }
    return evaluations;
  } finally {
    alertSweepActive = false;
  }
}

export async function logOperationsSummary(): Promise<Record<string, unknown>> {
  const [queueCounts, incidentCounts, rules] = await Promise.all([
    query<{ status: string; count: number }>(`SELECT status, COUNT(*)::int AS count FROM audit_governance.observability_log_export_queue GROUP BY status`),
    query<{ status: string; count: number }>(`SELECT status, COUNT(*)::int AS count FROM audit_governance.observability_alert_incidents GROUP BY status`),
    query<{ total: number; enabled: number }>(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE enabled)::int AS enabled FROM audit_governance.observability_alert_rules`),
  ]);
  return {
    retention: { days: RETENTION_DAYS, sweepSeconds: RETENTION_SWEEP_SEC, storage: getLogStorage().health() },
    exports: {
      targets: logExportTargets().map((target) => ({
        ...target,
        credentialConfigured: target.credentialEnv ? Boolean(process.env[target.credentialEnv]) : true,
      })),
      queue: Object.fromEntries(queueCounts.map((row) => [row.status, row.count])),
    },
    alerts: { rules: rules[0] ?? { total: 0, enabled: 0 }, incidents: Object.fromEntries(incidentCounts.map((row) => [row.status, row.count])) },
  };
}

export function startLogOperations(): void {
  void ensureDefaultLogAlertRule().then(() => evaluateLogAlerts()).catch((error) => console.warn("[log-operations] alert bootstrap failed", error));
  void processLogExportQueue().catch((error) => console.warn("[log-operations] export bootstrap failed", error));
  void runLogRetentionSweep().catch((error) => console.warn("[log-operations] retention bootstrap failed", error));
  exportTimer = setInterval(() => { void processLogExportQueue().catch((error) => console.warn("[log-operations] export sweep failed", error)); }, EXPORT_WORKER_SEC * 1_000);
  alertTimer = setInterval(() => { void evaluateLogAlerts().catch((error) => console.warn("[log-operations] alert sweep failed", error)); }, ALERT_EVAL_SEC * 1_000);
  retentionTimer = setInterval(() => { void runLogRetentionSweep().catch((error) => console.warn("[log-operations] retention sweep failed", error)); }, RETENTION_SWEEP_SEC * 1_000);
  for (const timer of [exportTimer, alertTimer, retentionTimer]) timer.unref?.();
}

export function stopLogOperations(): void {
  for (const timer of [exportTimer, alertTimer, retentionTimer]) if (timer) clearInterval(timer);
  exportTimer = null;
  alertTimer = null;
  retentionTimer = null;
}
