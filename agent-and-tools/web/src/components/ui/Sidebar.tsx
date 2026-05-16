"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import {
  LayoutDashboard, Bot, Wrench, Play, Users, BookOpen,
  GitBranch, Layers, ScrollText, ShieldCheck, Activity, Brain,
  ChevronLeft, ChevronRight, DollarSign, Cpu,
} from "lucide-react";

const registry = [
  { label: "Dashboard",     href: "/",              icon: LayoutDashboard },
  // M23 — single Agent Studio entry replaces flat Agents + Agent Templates pages
  { label: "Agent Studio",  href: "/agent-studio",  icon: Bot },
  { label: "Tools",         href: "/tools",         icon: Wrench },
  { label: "Executions",    href: "/executions",    icon: Play },
  { label: "Runners",       href: "/runners",       icon: Users },
  { label: "Learning",      href: "/learning",      icon: BookOpen },
];

const runtime = [
  { label: "Capabilities",        href: "/capabilities",        icon: GitBranch },
  { label: "Behavior Profiles",   href: "/prompt-profiles",     icon: Layers },
  { label: "Instruction Blocks",  href: "/prompt-layers",       icon: ScrollText },
  { label: "Tool Grants",         href: "/tool-grants",         icon: ShieldCheck },
  { label: "Runtime Receipts",    href: "/runtime-executions",  icon: Activity },
  { label: "Memory",              href: "/memory",              icon: Brain },
];

const governance = [
  { label: "LLM Settings", href: "/llm-settings", icon: Cpu },
  { label: "Audit",        href: "/audit",         icon: ShieldCheck },
  { label: "Cost",         href: "/cost",          icon: DollarSign },
];

type ItemDef = { label: string; href: string; icon: typeof LayoutDashboard };

function NavItem({
  label, href, icon: Icon, active, collapsed,
}: ItemDef & { active: boolean; collapsed: boolean }) {
  return (
    <Link href={href} className="block">
      <div
        className={`nav-item${active ? " active" : ""}`}
        title={collapsed ? label : undefined}
        style={collapsed ? { padding: "8px", justifyContent: "center" } : undefined}
      >
        {/* Active right-edge indicator */}
        {active && (
          <span
            style={{
              position: "absolute",
              right: 0,
              top: "50%",
              transform: "translateY(-50%)",
              width: 3,
              height: 20,
              borderRadius: "2px 0 0 2px",
              background: "var(--brand-green-accent)",
              boxShadow: "0 0 8px rgba(0,166,81,0.45)",
            }}
          />
        )}
        <Icon
          size={16}
          style={{ color: active ? "var(--brand-green-accent)" : "rgba(245,242,234,0.5)", flexShrink: 0 }}
        />
        {!collapsed && <span>{label}</span>}
      </div>
    </Link>
  );
}

export function Sidebar() {
  const path = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("sidebar-collapsed");
    if (stored !== null) setCollapsed(stored === "true");
  }, []);

  function toggle() {
    setCollapsed(c => {
      const next = !c;
      localStorage.setItem("sidebar-collapsed", String(next));
      return next;
    });
  }

  const isActive = (href: string) =>
    href === "/" ? path === "/" : path.startsWith(href);

  return (
    <aside className="shell-sidebar" style={{ width: collapsed ? 80 : 280 }}>

      {/* ── Brand header ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: collapsed ? "space-around" : "space-between",
          gap: collapsed ? 0 : 12,
          padding: "18px 16px 14px",
          borderBottom: "1px solid rgba(245,242,234,0.08)",
          flexShrink: 0,
        }}
      >
        {/* Logo + wordmark (hidden when collapsed) */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            minWidth: 0,
            opacity: collapsed ? 0 : 1,
            transition: "opacity 0.2s",
            pointerEvents: collapsed ? "none" : "auto",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/singularity-mark.png"
            alt="Singularity"
            width={40}
            height={40}
            style={{
              flexShrink: 0,
              filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.18))",
              userSelect: "none",
            }}
            onError={(e) => { (e.currentTarget as HTMLImageElement).src = "/singularity-logo.png" }}
          />
          <div>
            <h2
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "0.9375rem",
                fontWeight: 700,
                color: "var(--brand-warm-white)",
                letterSpacing: "0.04em",
                lineHeight: 1.2,
                margin: 0,
              }}
            >
              Singularity
            </h2>
            <p
              style={{
                fontSize: "0.5625rem",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.18em",
                color: "rgba(245,242,234,0.55)",
                opacity: 0.85,
                marginTop: 2,
                marginBottom: 0,
              }}
            >
              Governed Agentic Delivery
            </p>
          </div>
        </div>

        {/* Collapse toggle */}
        <button
          onClick={toggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          style={{
            width: 32, height: 32, borderRadius: 8, border: "none",
            background: "rgba(245,242,234,0.08)", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--brand-green-accent)", transition: "all 0.15s",
            flexShrink: 0,
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(245,242,234,0.14)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(245,242,234,0.08)"; }}
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>

      {/* ── Navigation ── */}
      <nav style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "12px 8px" }}>

        {/* Registry section */}
        {!collapsed && (
          <p className="label-xs" style={{ padding: "0 12px", marginBottom: 6 }}>Registry</p>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {registry.map(item => (
            <NavItem key={item.href} {...item} active={isActive(item.href)} collapsed={collapsed} />
          ))}
        </div>

        {/* Runtime section */}
        {!collapsed ? (
          <div style={{ marginTop: 20 }}>
            <p className="label-xs" style={{ padding: "0 12px", marginBottom: 6 }}>Runtime</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {runtime.map(item => (
                <NavItem key={item.href} {...item} active={isActive(item.href)} collapsed={false} />
              ))}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}>
            {runtime.map(item => (
              <NavItem key={item.href} {...item} active={isActive(item.href)} collapsed={true} />
            ))}
          </div>
        )}

        {/* Governance section (M21) */}
        {!collapsed ? (
          <div style={{ marginTop: 20 }}>
            <p className="label-xs" style={{ padding: "0 12px", marginBottom: 6 }}>Governance</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {governance.map(item => (
                <NavItem key={item.href} {...item} active={isActive(item.href)} collapsed={false} />
              ))}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}>
            {governance.map(item => (
              <NavItem key={item.href} {...item} active={isActive(item.href)} collapsed={true} />
            ))}
          </div>
        )}
      </nav>

      {/* ── Footer ── */}
      {!collapsed && (
        <div
          style={{
            padding: "8px 16px 16px",
            borderTop: "1px solid rgba(245,242,234,0.08)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.6875rem",
            color: "rgba(245,242,234,0.45)",
            opacity: 0.6,
            flexShrink: 0,
          }}
        >
          v1.0.0
        </div>
      )}
    </aside>
  );
}
