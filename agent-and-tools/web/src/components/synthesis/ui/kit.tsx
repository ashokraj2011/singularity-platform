"use client";

import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * Synthesis UI kit — small presentational primitives styled with the
 * "Ethos & Form" Tailwind tokens (scoped under `.synthesis-root`). Screens
 * compose these instead of re-deriving styling, keeping the product cohesive.
 */

/* ─── Card ──────────────────────────────────────────────────────────────── */

export function SynCard({
  children,
  className = "",
  interactive = false,
  as: Tag = "div",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  interactive?: boolean;
  as?: "div" | "section" | "article";
  style?: CSSProperties;
}) {
  return (
    <Tag
      className={[
        "bg-surface-container-lowest border border-outline-variant rounded-xl shadow-sm",
        interactive
          ? "group hover:border-secondary hover:shadow-md transition-all duration-300 cursor-pointer"
          : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/* ─── Chip ──────────────────────────────────────────────────────────────── */

export type ChipTone = "neutral" | "secondary" | "tertiary" | "error" | "success";

const chipTones: Record<ChipTone, string> = {
  neutral: "bg-surface-container-high text-on-surface-variant",
  secondary: "bg-secondary-container text-on-secondary-container",
  tertiary: "bg-tertiary-container/10 text-on-tertiary-container",
  error: "bg-error-container text-on-error-container",
  success: "bg-secondary-container text-on-secondary-container",
};

export function SynChip({
  children,
  tone = "neutral",
  mono = false,
  icon: Icon,
  className = "",
}: {
  children: ReactNode;
  tone?: ChipTone;
  mono?: boolean;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium tracking-wide",
        mono ? "font-mono uppercase" : "",
        chipTones[tone],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {Icon ? <Icon size={12} strokeWidth={2} /> : null}
      {children}
    </span>
  );
}

/* ─── Confidence bar ────────────────────────────────────────────────────── */

export function ConfidenceBar({
  value,
  label,
  className = "",
}: {
  /** 0–1 or 0–100; normalized automatically. */
  value: number;
  label?: string;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, value <= 1 ? value * 100 : value));
  const tone = pct >= 70 ? "bg-secondary" : pct >= 40 ? "bg-on-tertiary-container" : "bg-error";
  return (
    <div className={["flex items-center gap-2", className].filter(Boolean).join(" ")}>
      <div className="flex-1 h-1.5 rounded-full bg-surface-container-high overflow-hidden">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-[11px] text-on-surface-variant tabular-nums">
        {label ?? `${Math.round(pct)}%`}
      </span>
    </div>
  );
}

/* ─── Mono metadata line ────────────────────────────────────────────────── */

export function MonoMeta({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={[
        "font-mono text-[11px] uppercase tracking-wider text-on-surface-variant",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </span>
  );
}

/* ─── Stage / section header ────────────────────────────────────────────── */

export function StageHeader({
  eyebrow,
  title,
  description,
  actions,
  icon: Icon,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="flex items-start justify-between gap-6 mb-8">
      <div className="flex items-start gap-4 min-w-0">
        {Icon ? (
          <div className="mt-1 w-11 h-11 rounded-xl bg-secondary-container flex items-center justify-center text-on-secondary-container shrink-0">
            <Icon size={20} strokeWidth={1.8} />
          </div>
        ) : null}
        <div className="min-w-0">
          {eyebrow ? <MonoMeta className="block mb-1">{eyebrow}</MonoMeta> : null}
          <h1 className="font-display font-semibold text-2xl text-on-surface tracking-tight truncate">
            {title}
          </h1>
          {description ? (
            <p className="mt-1.5 text-sm text-on-surface-variant max-w-2xl">{description}</p>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex items-center gap-2 shrink-0">{actions}</div> : null}
    </div>
  );
}

/* ─── Button ────────────────────────────────────────────────────────────── */

export function SynButton({
  children,
  onClick,
  variant = "primary",
  icon: Icon,
  type = "button",
  disabled = false,
  className = "",
  title,
}: {
  children?: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost";
  icon?: LucideIcon;
  type?: "button" | "submit";
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const variants: Record<string, string> = {
    primary: "bg-primary text-on-primary hover:bg-primary/90 shadow-sm",
    secondary:
      "bg-secondary-container text-on-secondary-container hover:bg-secondary-container/80",
    ghost:
      "bg-transparent text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        "h-9 px-4 rounded-lg font-display font-semibold text-sm inline-flex items-center gap-2 transition-all active:scale-[0.98]",
        "disabled:opacity-45 disabled:cursor-not-allowed disabled:active:scale-100",
        variants[variant],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {Icon ? <Icon size={16} strokeWidth={2} /> : null}
      {children}
    </button>
  );
}

/* ─── Empty state ───────────────────────────────────────────────────────── */

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-20 px-6">
      {Icon ? (
        <div className="w-14 h-14 rounded-2xl bg-surface-container flex items-center justify-center text-on-surface-variant mb-5">
          <Icon size={24} strokeWidth={1.6} />
        </div>
      ) : null}
      <h3 className="font-display font-semibold text-lg text-on-surface">{title}</h3>
      {description ? (
        <p className="mt-2 text-sm text-on-surface-variant max-w-md">{description}</p>
      ) : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}

/* ─── Loading skeleton ──────────────────────────────────────────────────── */

export function SynSkeleton({ rows = 3, className = "" }: { rows?: number; className?: string }) {
  return (
    <div className={["space-y-3", className].filter(Boolean).join(" ")}>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-16 rounded-xl bg-surface-container-high/70 animate-pulse"
        />
      ))}
    </div>
  );
}

/* ─── Inline error ──────────────────────────────────────────────────────── */

export function SynError({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-error/30 bg-error-container/40 px-4 py-3 text-sm text-on-error-container">
      {message}
    </div>
  );
}
