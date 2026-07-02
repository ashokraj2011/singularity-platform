/**
 * Shared UI primitives (UX Phase 0b). One home for the page-level building blocks
 * that were previously re-implemented inline per page (PageHeader, MetricTile,
 * StatusCard, EmptyState, ErrorState, JsonPreview, CommandBlock, Stepper,
 * PermissionChip) + the unified StatusChip vocabulary. Pages migrate onto these
 * incrementally in the consistency pass; this module establishes the kit.
 *
 * Tailwind + CSS variables only, matching the existing card/badge language.
 */
import {
  AlertCircle, Check, ChevronRight, FileText, Inbox, type LucideIcon,
} from "lucide-react";
import { CopyButton } from "@/components/ui/CopyButton";

// ── PageHeader ──────────────────────────────────────────────────────────────
export function PageHeader({
  title, description, eyebrow, icon: Icon, actions,
}: {
  title: string;
  description?: React.ReactNode;
  eyebrow?: string;
  icon?: LucideIcon;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-hero">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="min-w-0">
          {eyebrow && (
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-emerald-800">
              {Icon && <Icon size={13} />}
              {eyebrow}
            </div>
          )}
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">{title}</h1>
          {description && <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

// ── MetricTile ──────────────────────────────────────────────────────────────
const METRIC_TONES = {
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-900",
  blue: "border-blue-200 bg-blue-50 text-blue-900",
  amber: "border-amber-200 bg-amber-50 text-amber-900",
  red: "border-red-200 bg-red-50 text-red-900",
  slate: "border-slate-200 bg-slate-50 text-slate-900",
} as const;

export function MetricTile({
  label, value, tone = "slate", icon: Icon,
}: { label: string; value: React.ReactNode; tone?: keyof typeof METRIC_TONES; icon?: LucideIcon }) {
  return (
    <div className={`rounded-xl border px-3 py-2 ${METRIC_TONES[tone]}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-bold uppercase tracking-[0.16em] opacity-70">{label}</div>
        {Icon && <Icon size={15} className="opacity-70" />}
      </div>
      <div className="mt-1 text-2xl font-bold leading-none">{value}</div>
    </div>
  );
}

// ── StatusChip — the one status vocabulary across the product ────────────────
export type UiState =
  | "ready"
  | "waiting"
  | "blocked"
  | "offline"
  | "guarded"
  | "optional"
  | "needs-auth"
  | "needs-runtime"
  | "degraded";
const STATE_STYLE: Record<UiState, { label: string; cls: string }> = {
  ready:           { label: "Ready",         cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  waiting:         { label: "Waiting",       cls: "border-amber-200 bg-amber-50 text-amber-800" },
  degraded:        { label: "Degraded",      cls: "border-amber-200 bg-amber-50 text-amber-800" },
  blocked:         { label: "Blocked",       cls: "border-red-200 bg-red-50 text-red-700" },
  offline:         { label: "Offline",       cls: "border-slate-200 bg-slate-100 text-slate-600" },
  guarded:         { label: "Needs auth",    cls: "border-blue-200 bg-blue-50 text-blue-700" },
  "needs-auth":    { label: "Needs auth",    cls: "border-blue-200 bg-blue-50 text-blue-700" },
  "needs-runtime": { label: "Needs runtime", cls: "border-violet-200 bg-violet-50 text-violet-700" },
  optional:        { label: "Optional",      cls: "border-slate-200 bg-slate-50 text-slate-500" },
};

export function StatusChip({ state, label }: { state: UiState; label?: string }) {
  const s = STATE_STYLE[state];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${s.cls}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden />
      {label ?? s.label}
    </span>
  );
}

export function StatusPill({ state, label, icon: Icon }: { state: UiState; label?: string; icon?: LucideIcon }) {
  const s = STATE_STYLE[state];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold ${s.cls}`}>
      {Icon ? <Icon size={13} /> : <span className="h-1.5 w-1.5 rounded-full bg-current opacity-75" aria-hidden />}
      {label ?? s.label}
    </span>
  );
}

// ── Modern page and layout primitives ──────────────────────────────────────
export function PageShell({
  children,
  maxWidth = 1320,
  className = "",
}: {
  children: React.ReactNode;
  maxWidth?: number;
  className?: string;
}) {
  return (
    <div className={`mx-auto w-full ${className}`} style={{ maxWidth }}>
      {children}
    </div>
  );
}

export function IconTile({
  icon: Icon,
  tone = "emerald",
  size = "md",
  title,
}: {
  icon: LucideIcon;
  tone?: "emerald" | "blue" | "violet" | "amber" | "rose" | "slate";
  size?: "sm" | "md" | "lg";
  title?: string;
}) {
  const tones = {
    emerald: "bg-emerald-50 text-emerald-700 ring-emerald-100",
    blue: "bg-blue-50 text-blue-700 ring-blue-100",
    violet: "bg-violet-50 text-violet-700 ring-violet-100",
    amber: "bg-amber-50 text-amber-700 ring-amber-100",
    rose: "bg-rose-50 text-rose-700 ring-rose-100",
    slate: "bg-slate-100 text-slate-600 ring-slate-200",
  } as const;
  const sizes = {
    sm: "h-8 w-8 rounded-lg",
    md: "h-10 w-10 rounded-lg",
    lg: "h-12 w-12 rounded-xl",
  } as const;
  const iconSize = size === "lg" ? 22 : size === "md" ? 18 : 15;
  return (
    <span title={title} className={`inline-flex shrink-0 items-center justify-center ring-1 ${sizes[size]} ${tones[tone]}`}>
      <Icon size={iconSize} strokeWidth={2.1} />
    </span>
  );
}

export function PageHero({
  eyebrow,
  title,
  description,
  icon,
  tone = "emerald",
  actions,
  rail,
}: {
  eyebrow?: string;
  title: string;
  description?: React.ReactNode;
  icon?: LucideIcon;
  tone?: "emerald" | "blue" | "violet" | "amber" | "rose" | "slate";
  actions?: React.ReactNode;
  rail?: React.ReactNode;
}) {
  return (
    <section className="page-hero">
      <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
        <div className="min-w-0">
          {eyebrow && (
            <div className="mb-3 inline-flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
              {icon && <IconTile icon={icon} tone={tone} size="sm" />}
              {eyebrow}
            </div>
          )}
          <h1 className="text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">{title}</h1>
          {description && <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">{description}</p>}
          {rail && <div className="mt-5">{rail}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </section>
  );
}

export function MetricStrip({
  items,
}: {
  items: Array<{ label: string; value: React.ReactNode; icon?: LucideIcon; state?: UiState; hint?: string }>;
}) {
  return (
    <section className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <article key={item.label} className="metric-card">
            <div className="flex items-center justify-between gap-2">
              <span className="label-xs">{item.label}</span>
              {Icon && <Icon size={15} className="text-slate-400" />}
            </div>
            <div className="mt-2 flex items-end justify-between gap-3">
              <strong className="text-2xl font-black leading-none text-slate-950">{item.value}</strong>
              {item.state && <StatusPill state={item.state} />}
            </div>
            {item.hint && <p className="mt-2 text-xs leading-5 text-slate-500">{item.hint}</p>}
          </article>
        );
      })}
    </section>
  );
}

export function DataPanel({
  title,
  description,
  icon = FileText,
  actions,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="data-panel">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <IconTile icon={icon} tone="slate" />
          <div className="min-w-0">
            <h2 className="text-base font-black text-slate-950">{title}</h2>
            {description && <p className="mt-1 text-sm leading-6 text-slate-500">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function EvidenceRail({
  items,
}: {
  items: Array<{ label: string; detail?: string; icon?: LucideIcon; state?: UiState }>;
}) {
  return (
    <div className="evidence-rail">
      {items.map((item, index) => {
        const Icon = item.icon ?? Check;
        return (
          <div key={`${item.label}-${index}`} className="evidence-step">
            <IconTile icon={Icon} tone={item.state === "blocked" ? "rose" : item.state === "waiting" ? "amber" : "emerald"} size="sm" />
            <div className="min-w-0">
              <div className="text-xs font-black text-slate-900">{item.label}</div>
              {item.detail && <div className="mt-0.5 text-[11px] leading-4 text-slate-500">{item.detail}</div>}
            </div>
            {item.state && <StatusPill state={item.state} />}
          </div>
        );
      })}
    </div>
  );
}

export function Timeline({
  items,
}: {
  items: Array<{ title: string; detail?: React.ReactNode; meta?: string; state?: UiState; icon?: LucideIcon }>;
}) {
  return (
    <ol className="timeline">
      {items.map((item, index) => {
        const Icon = item.icon ?? Check;
        return (
          <li key={`${item.title}-${index}`} className="timeline-item">
            <IconTile icon={Icon} tone={item.state === "blocked" ? "rose" : item.state === "waiting" ? "amber" : "emerald"} size="sm" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-sm text-slate-950">{item.title}</strong>
                {item.state && <StatusPill state={item.state} />}
              </div>
              {item.detail && <div className="mt-1 text-sm leading-6 text-slate-600">{item.detail}</div>}
              {item.meta && <div className="mt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">{item.meta}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="grid gap-2">
      {Array.from({ length: lines }).map((_, index) => (
        <span key={index} className="h-3 animate-pulse rounded-full bg-slate-100" style={{ width: `${90 - index * 12}%` }} />
      ))}
    </div>
  );
}

// ── StatusCard ──────────────────────────────────────────────────────────────
export function StatusCard({
  title, state, stateLabel, actions, children,
}: {
  title: string;
  state?: UiState;
  stateLabel?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        <div className="flex items-center gap-2">
          {state && <StatusChip state={state} label={stateLabel} />}
          {actions}
        </div>
      </div>
      {children && <div className="mt-3 text-sm text-slate-600">{children}</div>}
    </section>
  );
}

// ── EmptyState ──────────────────────────────────────────────────────────────
export function EmptyState({
  title, hint, icon: Icon = Inbox,
}: { title: string; hint?: React.ReactNode; icon?: LucideIcon }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-6 py-10 text-center">
      <Icon size={22} className="text-slate-400" />
      <div className="text-sm font-semibold text-slate-700">{title}</div>
      {hint && <div className="max-w-md text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

// ── ErrorState ──────────────────────────────────────────────────────────────
export function ErrorState({ error, compact = false }: { error: unknown; compact?: boolean }) {
  const message = error instanceof Error ? error.message : String(error ?? "Something went wrong");
  return (
    <div className={`flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 text-red-700 ${compact ? "px-3 py-2 text-xs" : "px-4 py-3 text-sm"}`}>
      <AlertCircle size={compact ? 14 : 16} className="mt-0.5 shrink-0" />
      <span className="min-w-0 break-words">{message}</span>
    </div>
  );
}

// ── JsonPreview ─────────────────────────────────────────────────────────────
export function JsonPreview({ value, maxHeight = 320 }: { value: unknown; maxHeight?: number }) {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return (
    <pre
      className="overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-[12px] leading-5 text-slate-800"
      style={{ maxHeight, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}
    >
      {text}
    </pre>
  );
}

// ── CommandBlock — copyable shell command ───────────────────────────────────
export function CommandBlock({ command, label }: { command: string; label?: string }) {
  return (
    <div>
      {label && <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{label}</div>}
      <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-900 px-3 py-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-[12px] text-slate-100" style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
          {command}
        </code>
        <CopyButton text={command} label="Copy command" />
      </div>
    </div>
  );
}

// ── Stepper ─────────────────────────────────────────────────────────────────
export type Step = { label: string; status?: "done" | "current" | "todo" };
export function Stepper({ steps }: { steps: Step[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-1 text-xs">
      {steps.map((step, i) => {
        const status = step.status ?? "todo";
        const tone =
          status === "done" ? "bg-emerald-600 text-white border-emerald-600"
          : status === "current" ? "bg-emerald-50 text-emerald-800 border-emerald-300"
          : "bg-white text-slate-500 border-slate-200";
        return (
          <li key={step.label} className="flex items-center gap-1">
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-semibold ${tone}`}>
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-current text-[10px]">
                {status === "done" ? <Check size={10} /> : i + 1}
              </span>
              {step.label}
            </span>
            {i < steps.length - 1 && <ChevronRight size={13} className="text-slate-300" />}
          </li>
        );
      })}
    </ol>
  );
}

// ── PermissionChip ──────────────────────────────────────────────────────────
export type PermissionKind = "read" | "invoke" | "configure" | "edit" | "provider-locked";
const PERMISSION_STYLE: Record<PermissionKind, { label: string; cls: string }> = {
  read:              { label: "Read-only",      cls: "border-slate-200 bg-slate-50 text-slate-600" },
  invoke:            { label: "Invoke",         cls: "border-blue-200 bg-blue-50 text-blue-700" },
  configure:         { label: "Configure",      cls: "border-amber-200 bg-amber-50 text-amber-800" },
  edit:              { label: "Edit",           cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  "provider-locked": { label: "Provider locked", cls: "border-slate-200 bg-slate-100 text-slate-500" },
};
export function PermissionChip({ kind, label }: { kind: PermissionKind; label?: string }) {
  const p = PERMISSION_STYLE[kind];
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${p.cls}`}>
      {label ?? p.label}
    </span>
  );
}
