"use client";

/**
 * Small CSS-var form primitives shared by the Git Credential Broker admin pages
 * (slice E). Matches the legacy identity-console idiom (`.card` / `.btn-primary`
 * + `var(--color-*)` inline styles) so these pages sit visually alongside their
 * Identity & Access neighbours.
 */

const labelStyle: React.CSSProperties = {
  display: "grid",
  gap: 5,
  fontSize: 12,
  fontWeight: 800,
  color: "var(--color-outline)",
};

const controlStyle: React.CSSProperties = {
  border: "1px solid var(--color-outline-variant)",
  borderRadius: 8,
  padding: "9px 11px",
  fontSize: 13,
  color: "var(--color-text)",
  fontWeight: 500,
  background: "var(--color-surface)",
  width: "100%",
};

export function PageShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "grid", gap: 16, padding: 20 }}>
      <header>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: "var(--color-text)" }}>{title}</h1>
        {description ? (
          <p style={{ margin: "4px 0 0", color: "var(--color-outline)", fontSize: 13, maxWidth: 720 }}>{description}</p>
        ) : null}
      </header>
      {children}
    </div>
  );
}

export function TwoColumn({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) minmax(360px, 0.95fr)",
        gap: 16,
        alignItems: "start",
      }}
    >
      {children}
    </div>
  );
}

export function GitField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  mono = false,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  mono?: boolean;
  disabled?: boolean;
}) {
  return (
    <label style={labelStyle}>
      {label}
      <input
        value={value}
        type={type}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ ...controlStyle, fontFamily: mono ? "var(--font-mono, monospace)" : undefined, opacity: disabled ? 0.72 : 1 }}
      />
    </label>
  );
}

export function GitTextarea({
  label,
  value,
  onChange,
  placeholder,
  rows = 6,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <label style={labelStyle}>
      {label}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        style={{ ...controlStyle, fontFamily: "var(--font-mono, monospace)", resize: "vertical" }}
      />
    </label>
  );
}

export function GitSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <label style={labelStyle}>
      {label}
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)} style={{ ...controlStyle, opacity: disabled ? 0.72 : 1 }}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function GitCheckboxGroup({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: Set<string>;
  onToggle: (value: string) => void;
}) {
  return (
    <fieldset style={{ ...labelStyle, border: "none", padding: 0, margin: 0 }}>
      <legend style={{ padding: 0, marginBottom: 6 }}>{label}</legend>
      <div style={{ display: "grid", gap: 6 }}>
        {options.map((o) => (
          <label
            key={o.value}
            style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 500, cursor: "pointer", color: "var(--color-text)" }}
          >
            <input type="checkbox" checked={selected.has(o.value)} onChange={() => onToggle(o.value)} style={{ cursor: "pointer" }} />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Chip({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "good" }) {
  const good = tone === "good";
  return (
    <span
      style={{
        border: `1px solid ${good ? "var(--color-success, #15803d)" : "var(--color-outline-variant)"}`,
        color: good ? "var(--color-success, #15803d)" : "var(--color-text)",
        borderRadius: 999,
        padding: "3px 9px",
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      style={{
        margin: 0,
        fontSize: 12,
        color: "var(--color-error, #b91c1c)",
        border: "1px solid var(--color-error, #b91c1c)",
        borderRadius: 8,
        padding: "8px 10px",
      }}
    >
      {message}
    </p>
  );
}

export function SubmitButton({
  busy,
  disabled,
  idleLabel,
  busyLabel,
  onClick,
}: {
  busy: boolean;
  disabled: boolean;
  idleLabel: string;
  busyLabel: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="btn-primary" disabled={busy || disabled} onClick={onClick}>
      {busy ? busyLabel : idleLabel}
    </button>
  );
}
