"use client";

import Link from "next/link";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw, Wrench } from "lucide-react";
import { sanitizeWorkgraphSurfaceText } from "./workgraph-diagnostics";

export class WorkgraphSurfaceBoundary extends Component<
  { children: ReactNode; surfaceLabel?: string },
  { error: Error | null; details: string }
> {
  state: { error: Error | null; details: string } = { error: null, details: "" };

  static getDerivedStateFromError(error: Error) {
    return { error, details: "" };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const message = sanitizeWorkgraphSurfaceText(error.message);
    const details = sanitizeWorkgraphSurfaceText(info.componentStack ?? "");
    this.setState({ details });
    console.warn("[WorkgraphSurfaceBoundary] Workgraph surface failed:", message, details);
  }

  retry = () => {
    this.setState({ error: null, details: "" });
  };

  render() {
    if (!this.state.error) return this.props.children;
    const label = this.props.surfaceLabel ?? "Workgraph surface";
    const message = sanitizeWorkgraphSurfaceText(this.state.error.message);
    return (
      <section className="data-panel" style={{ borderColor: "#fecaca", background: "#fff7f7" }}>
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
          <span
            aria-hidden="true"
            style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              display: "grid",
              placeItems: "center",
              background: "#fee2e2",
              color: "#b91c1c",
              flex: "0 0 auto",
            }}
          >
            <AlertTriangle size={20} />
          </span>
          <div style={{ flex: "1 1 320px", minWidth: 0 }}>
            <div className="label-xs" style={{ color: "#b91c1c", marginBottom: 6 }}>
              {label} unavailable
            </div>
            <h2 style={{ margin: 0, color: "var(--color-on-surface)", fontSize: 18, fontWeight: 900 }}>
              This workflow screen could not render.
            </h2>
            <p style={{ margin: "8px 0 0", color: "var(--color-outline)", fontSize: 13, lineHeight: 1.55 }}>
              The unified shell is still running, but the embedded Workgraph page hit a client-side exception. Check
              Workgraph readiness and retry before falling back to the setup tools.
            </p>
            <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn-secondary" type="button" onClick={this.retry}>
                <RefreshCw size={14} /> Retry surface
              </button>
              <Link className="btn-secondary" href="/operations/readiness">
                <Wrench size={14} /> Check readiness
              </Link>
              <Link className="btn-secondary" href="/workflows/start">
                Guided launch
              </Link>
            </div>
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: "pointer", color: "#991b1b", fontSize: 12, fontWeight: 800 }}>
                Technical details
              </summary>
              <pre style={{ marginTop: 8, maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", color: "#7f1d1d", fontSize: 12 }}>
                {message}
                {this.state.details ? `\n${this.state.details}` : ""}
              </pre>
            </details>
          </div>
        </div>
      </section>
    );
  }
}
