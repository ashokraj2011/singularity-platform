"use client";

import { useMemo, useState } from "react";
import { ExternalLink, Maximize2, RefreshCw } from "lucide-react";
import { getControlPlaneApp } from "@/lib/controlPlaneApps";

export function EmbeddedControlPlaneApp({ appId }: { appId: string }) {
  const app = useMemo(() => getControlPlaneApp(appId), [appId]);
  const [frameKey, setFrameKey] = useState(0);
  const Icon = app.icon;

  return (
    <div style={{ minHeight: "calc(100vh - 7rem)", display: "flex", flexDirection: "column", gap: 14 }}>
      <section
        className="card"
        style={{
          padding: 18,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
          <span
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              display: "grid",
              placeItems: "center",
              background: "rgba(0,132,61,0.10)",
              color: "var(--color-primary)",
              flexShrink: 0,
            }}
          >
            <Icon size={21} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 5 }}>
              {app.group}
            </div>
            <h1 className="page-header" style={{ margin: 0 }}>{app.label}</h1>
            <p style={{ marginTop: 6, maxWidth: 820, color: "var(--color-outline)", fontSize: 13, lineHeight: 1.45 }}>
              {app.summary}
            </p>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap", marginLeft: "auto" }}>
          <button
            type="button"
            onClick={() => setFrameKey((value) => value + 1)}
            className="btn-secondary"
            style={{ height: 38, display: "inline-flex", alignItems: "center", gap: 8 }}
          >
            <RefreshCw size={15} />
            Refresh
          </button>
          <a
            href={app.nativeHref}
            className="btn-primary"
            style={{ height: 38, display: "inline-flex", alignItems: "center", gap: 8, textDecoration: "none" }}
          >
            <Maximize2 size={15} />
            Open native
          </a>
        </div>
      </section>

      <section
        className="card"
        style={{
          minHeight: 700,
          flex: 1,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            height: 44,
            padding: "0 14px",
            borderBottom: "1px solid var(--color-outline-variant)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            background: "var(--color-surface-low)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "var(--color-on-surface)" }}>{app.label}</div>
            <div style={{ fontSize: 11, color: "var(--color-outline)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {app.nativeHref}
            </div>
          </div>
          <a
            href={app.nativeHref}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              color: "var(--color-primary)",
              fontSize: 12,
              fontWeight: 800,
              textDecoration: "none",
              flexShrink: 0,
            }}
          >
            Open
            <ExternalLink size={13} />
          </a>
        </div>
        <iframe
          key={`${app.id}-${frameKey}`}
          title={app.label}
          src={app.nativeHref}
          style={{
            flex: 1,
            width: "100%",
            minHeight: 650,
            border: 0,
            background: "#fff",
          }}
        />
      </section>
    </div>
  );
}
