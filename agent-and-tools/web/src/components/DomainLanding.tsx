import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, CheckCircle2 } from "lucide-react";

export type DomainAction = {
  label: string;
  href: string;
  description: string;
  icon: LucideIcon;
  primary?: boolean;
};

export type DomainSignal = {
  label: string;
  value: string;
  tone?: "green" | "blue" | "amber" | "slate";
};

const toneMap = {
  green: { bg: "rgba(54,135,39,0.10)", fg: "#007a3d", border: "rgba(54,135,39,0.25)" },
  blue: { bg: "rgba(0,75,141,0.10)", fg: "#004b8d", border: "rgba(0,75,141,0.22)" },
  amber: { bg: "rgba(217,119,6,0.12)", fg: "#92400e", border: "rgba(217,119,6,0.24)" },
  slate: { bg: "rgba(70,80,99,0.08)", fg: "#465063", border: "rgba(70,80,99,0.18)" },
};

export function DomainLanding({
  eyebrow,
  title,
  description,
  actions,
  signals = [],
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions: DomainAction[];
  signals?: DomainSignal[];
}) {
  return (
    <div style={{ maxWidth: 1180 }}>
      <section style={{ marginBottom: 24 }}>
        <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 10 }}>
          {eyebrow}
        </div>
        <h1 className="page-header" style={{ fontSize: "2rem", marginBottom: 8 }}>
          {title}
        </h1>
        <p style={{ maxWidth: 820, color: "var(--color-outline)", lineHeight: 1.6, fontSize: 14 }}>
          {description}
        </p>
      </section>

      {signals.length > 0 && (
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
            gap: 12,
            marginBottom: 22,
          }}
        >
          {signals.map((signal) => {
            const tone = toneMap[signal.tone ?? "slate"];
            return (
              <div
                key={signal.label}
                className="card"
                style={{
                  padding: 16,
                  borderColor: tone.border,
                  background: tone.bg,
                  boxShadow: "none",
                }}
              >
                <div className="label-xs" style={{ color: tone.fg, marginBottom: 8 }}>
                  {signal.label}
                </div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "var(--color-on-surface)" }}>
                  {signal.value}
                </div>
              </div>
            );
          })}
        </section>
      )}

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 14,
        }}
      >
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <Link key={action.href} href={action.href} style={{ textDecoration: "none" }}>
              <article
                className="card card-hover"
                style={{
                  minHeight: 166,
                  padding: 18,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  borderColor: action.primary ? "rgba(54,135,39,0.36)" : "var(--color-outline-variant)",
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <span
                      style={{
                        width: 38,
                        height: 38,
                        borderRadius: 10,
                        display: "grid",
                        placeItems: "center",
                        background: action.primary ? "var(--color-primary)" : "var(--color-surface-container)",
                        color: action.primary ? "#fff" : "var(--color-primary)",
                      }}
                    >
                      <Icon size={18} />
                    </span>
                    {action.primary && (
                      <span className="badge badge-active" style={{ gap: 5 }}>
                        <CheckCircle2 size={12} />
                        Primary
                      </span>
                    )}
                  </div>
                  <h2 style={{ marginTop: 14, marginBottom: 6, fontSize: 16, fontWeight: 800, color: "var(--color-on-surface)" }}>
                    {action.label}
                  </h2>
                  <p style={{ fontSize: 13, color: "var(--color-outline)", lineHeight: 1.5, margin: 0 }}>
                    {action.description}
                  </p>
                </div>
                <div style={{ marginTop: 16, color: "var(--color-primary)", fontSize: 13, fontWeight: 800, display: "flex", alignItems: "center", gap: 6 }}>
                  Open
                  <ArrowRight size={14} />
                </div>
              </article>
            </Link>
          );
        })}
      </section>
    </div>
  );
}
