"use client";

import { useMemo, useState } from "react";
import {
  Compass,
  ExternalLink,
  Maximize2,
  RefreshCw,
} from "lucide-react";
import { controlPlaneApps } from "@/lib/controlPlaneApps";

export default function ControlPlanePage() {
  const apps = useMemo(controlPlaneApps, []);
  const [selectedId, setSelectedId] = useState(apps[1]?.id ?? apps[0]?.id ?? "");
  const [frameKey, setFrameKey] = useState(0);
  const selected = apps.find((app) => app.id === selectedId) ?? apps[0];
  const SelectedIcon = selected.icon;

  return (
    <div style={{ minHeight: "calc(100vh - 7rem)", display: "flex", flexDirection: "column", gap: 18 }}>
      <section
        className="card"
        style={{
          padding: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            className="label-xs"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              color: "var(--color-primary)",
              marginBottom: 10,
            }}
          >
            <Compass size={14} />
            Singularity Control Plane
          </div>
          <h1 className="page-header" style={{ margin: 0 }}>
            Unified Command Center
          </h1>
          <p style={{ marginTop: 8, maxWidth: 900, color: "var(--color-outline)", fontSize: 14, lineHeight: 1.5 }}>
            One operator shell for Agent Studio, Workgraph, WorkbenchNeo, Identity, and Operations.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
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
            href={selected.nativeHref}
            className="btn-primary"
            style={{ height: 38, display: "inline-flex", alignItems: "center", gap: 8, textDecoration: "none" }}
          >
            <Maximize2 size={15} />
            Open full
          </a>
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
        {apps.map((app) => {
          const Icon = app.icon;
          const active = app.id === selected.id;
          return (
            <button
              key={app.id}
              type="button"
              onClick={() => setSelectedId(app.id)}
              className="card card-hover"
              style={{
                padding: 14,
                textAlign: "left",
                cursor: "pointer",
                borderColor: active ? "rgba(0,132,61,0.48)" : "var(--color-outline-variant)",
                background: active ? "rgba(0,132,61,0.07)" : "#fff",
                minHeight: 118,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <span
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    display: "grid",
                    placeItems: "center",
                    background: active ? "var(--color-primary)" : "var(--color-surface-container)",
                    color: active ? "#fff" : "var(--color-primary)",
                  }}
                >
                  <Icon size={17} />
                </span>
                <span className="label-xs" style={{ color: active ? "var(--color-primary)" : "var(--color-outline)" }}>
                  {app.group}
                </span>
              </div>
              <div style={{ marginTop: 12, fontSize: 15, fontWeight: 800, color: "var(--color-on-surface)" }}>
                {app.label}
              </div>
              <div style={{ marginTop: 5, fontSize: 12, lineHeight: 1.45, color: "var(--color-outline)" }}>
                {app.summary}
              </div>
            </button>
          );
        })}
      </section>

      <section
        className="card"
        style={{
          minHeight: 620,
          flex: 1,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            height: 48,
            padding: "0 14px",
            borderBottom: "1px solid var(--color-outline-variant)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            background: "var(--color-surface-low)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <span
              style={{
                width: 30,
                height: 30,
                borderRadius: 9,
                display: "grid",
                placeItems: "center",
                background: "rgba(0,132,61,0.10)",
                color: "var(--color-primary)",
              }}
            >
              <SelectedIcon size={16} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: "var(--color-on-surface)" }}>{selected.label}</div>
              <div style={{ fontSize: 11, color: "var(--color-outline)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {selected.nativeHref}
              </div>
            </div>
          </div>
          <a
            href={selected.nativeHref}
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
          key={`${selected.id}-${frameKey}`}
          title={selected.label}
          src={selected.nativeHref}
          style={{
            flex: 1,
            width: "100%",
            minHeight: 560,
            border: 0,
            background: "#fff",
          }}
        />
      </section>
    </div>
  );
}
