import { asRow, asRowArray, asString } from "@/lib/row";

export type NotificationSeverity = "blocked" | "warning" | "info" | "success";
export type NotificationCategory = "workflow" | "runtime" | "security" | "governance" | "setup" | "agents";

export type PlatformNotification = {
  id: string;
  title: string;
  message: string;
  severity: NotificationSeverity;
  category: NotificationCategory;
  source: string;
  href: string;
  actionLabel: string;
  fixCommand?: string;
  generatedAt?: string;
};

export type NotificationPreferences = Record<NotificationCategory, boolean>;

export type NotificationLocalState = Record<string, {
  read?: boolean;
  resolved?: boolean;
  snoozedUntil?: number;
}>;

export const NOTIFICATION_PREFERENCES_KEY = "singularity.notification.preferences.v1";
export const NOTIFICATION_STATE_KEY = "singularity.notification.state.v1";

export const NOTIFICATION_CATEGORIES: Array<{ id: NotificationCategory; label: string; description: string }> = [
  { id: "workflow", label: "Workflow", description: "Runs, WorkItems, approvals, and SDLC evidence." },
  { id: "runtime", label: "Runtime & Models", description: "Runtime Bridge, MCP, provider, and model readiness." },
  { id: "security", label: "Security", description: "IAM, access keys, runtime tokens, and authentication issues." },
  { id: "governance", label: "Governance", description: "Audit, trust evidence, Git push, and release handoff." },
  { id: "setup", label: "Setup", description: "Core platform services and required setup tasks." },
  { id: "agents", label: "Agents", description: "Agent Studio seeds, templates, tools, and profiles." },
];

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  workflow: true,
  runtime: true,
  security: true,
  governance: true,
  setup: true,
  agents: true,
};

export function normalizeNotificationPreferences(value: unknown): NotificationPreferences {
  const row = asRow(value);
  return NOTIFICATION_CATEGORIES.reduce((prefs, category) => {
    prefs[category.id] = row[category.id] === false ? false : true;
    return prefs;
  }, { ...DEFAULT_NOTIFICATION_PREFERENCES });
}

export function loadNotificationPreferences(): NotificationPreferences {
  if (typeof window === "undefined") return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  try {
    const raw = window.localStorage.getItem(NOTIFICATION_PREFERENCES_KEY);
    return normalizeNotificationPreferences(raw ? JSON.parse(raw) as unknown : null);
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  }
}

export function saveNotificationPreferences(prefs: NotificationPreferences): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(NOTIFICATION_PREFERENCES_KEY, JSON.stringify(normalizeNotificationPreferences(prefs)));
  window.dispatchEvent(new CustomEvent("singularity-notification-preferences-changed"));
}

export function loadNotificationState(): NotificationLocalState {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(NOTIFICATION_STATE_KEY);
    const row = asRow(raw ? JSON.parse(raw) as unknown : null);
    const state: NotificationLocalState = {};
    for (const [key, value] of Object.entries(row)) {
      const item = asRow(value);
      state[key] = {
        ...(item.read === true ? { read: true } : {}),
        ...(item.resolved === true ? { resolved: true } : {}),
        ...(typeof item.snoozedUntil === "number" && Number.isFinite(item.snoozedUntil) ? { snoozedUntil: item.snoozedUntil } : {}),
      };
    }
    return state;
  } catch {
    return {};
  }
}

export function saveNotificationState(state: NotificationLocalState): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(NOTIFICATION_STATE_KEY, JSON.stringify(state));
  window.dispatchEvent(new CustomEvent("singularity-notification-state-changed"));
}

export function notificationCategoryForCheck(check: Record<string, unknown>): NotificationCategory {
  const id = asString(check.id);
  const group = asString(check.group);
  if (id.includes("runtime") || id.includes("llm") || group === "runtime") return "runtime";
  if (id.includes("iam") || id.includes("access") || id.includes("token")) return "security";
  if (id.includes("agent")) return "agents";
  if (id.includes("workflow") || id.includes("workgraph") || group === "sdlc") return "workflow";
  if (id.includes("audit") || id.includes("git") || group === "governance") return "governance";
  return "setup";
}

export function notificationActionLabel(item: PlatformNotification): string {
  if (item.category === "runtime") return "Open Runtime & Models";
  if (item.category === "security") return "Open Security";
  if (item.category === "workflow") return "Open Workflows";
  if (item.category === "agents") return "Open Agent Studio";
  if (item.category === "governance") return "Open Evidence";
  return "Open Setup";
}

export function derivePlatformNotifications(health: unknown): PlatformNotification[] {
  const root = asRow(health);
  const generatedAt = asString(root.generatedAt);
  const checks = asRowArray(root.checks);
  const notifications = checks
    .filter((check) => {
      const status = asString(check.status);
      return status === "blocked" || status === "warning";
    })
    .map((check) => {
      const status = asString(check.status) === "blocked" ? "blocked" : "warning";
      const category = notificationCategoryForCheck(check);
      const item: PlatformNotification = {
        id: `health:${asString(check.id, asString(check.label, "check")).toLowerCase().replace(/[^a-z0-9:-]+/g, "-")}`,
        title: asString(check.label, "Platform check"),
        message: asString(check.summary ?? check.message ?? check.details, "This platform check needs attention."),
        severity: status,
        category,
        source: asString(check.group, "platform"),
        href: asString(check.fixRoute, category === "runtime" ? "/llm-settings" : "/operations/readiness"),
        actionLabel: "Open",
        ...(asString(check.fixCommand) ? { fixCommand: asString(check.fixCommand) } : {}),
        ...(generatedAt ? { generatedAt } : {}),
      };
      return { ...item, actionLabel: notificationActionLabel(item) };
    });

  if (notifications.length > 0) return notifications;

  const summary = asRow(root.summary);
  return [{
    id: "health:platform-ready",
    title: "Platform checks are clear",
    message: `No blocked or warning checks. Runtime clients: ${asString(summary.connectedRuntimeCount, "0")} · ready models: ${asString(summary.readyModelAliasCount, "0")}.`,
    severity: "success",
    category: "setup",
    source: "platform",
    href: "/operations/readiness",
    actionLabel: "View Readiness",
    ...(generatedAt ? { generatedAt } : {}),
  }];
}

export function applyNotificationState(
  items: PlatformNotification[],
  state: NotificationLocalState,
  prefs: NotificationPreferences,
  now = Date.now(),
): PlatformNotification[] {
  return items.filter((item) => {
    if (!prefs[item.category]) return false;
    const local = state[item.id];
    if (local?.resolved) return false;
    if (local?.snoozedUntil && local.snoozedUntil > now) return false;
    return true;
  });
}

export function unresolvedNotificationCount(items: PlatformNotification[], state: NotificationLocalState): number {
  return items.filter((item) => item.severity !== "success" && !state[item.id]?.read).length;
}
