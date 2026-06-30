"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { sidebarSections, type RouteMeta, type SidebarSection } from "@/lib/nav/routes";

// Sidebar groups + items now come from the shared route registry
// (src/lib/nav/routes.ts) — the single source of truth shared with the app
// switcher, help, and (soon) the command palette + breadcrumbs. This renders the
// same groups/order/icons as the previous hardcoded list.
const menuSections = sidebarSections();

const allMenuItems = menuSections.flatMap((section) => section.items);

function NavItem({
  label, href, icon: Icon, active, collapsed,
}: RouteMeta & { active: boolean; collapsed: boolean }) {
  return (
    <Link href={href} className="block" aria-current={active ? "page" : undefined}>
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
          style={{ color: active ? "var(--color-primary)" : "var(--color-outline)", flexShrink: 0 }}
        />
        {!collapsed && <span>{label}</span>}
      </div>
    </Link>
  );
}

export function Sidebar() {
  const path = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [narrowViewport, setNarrowViewport] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("sidebar-collapsed");
    if (stored !== null) setCollapsed(stored === "true");
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const sync = () => setNarrowViewport(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  function toggle() {
    setCollapsed(c => {
      const next = !c;
      localStorage.setItem("sidebar-collapsed", String(next));
      return next;
    });
  }

  const matchesHref = (href: string) =>
    href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
  const activeHref = allMenuItems
    .filter((item) => matchesHref(item.href))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  const isActive = (href: string) => href === activeHref;
  const canvasRoute = path.startsWith("/prompt-workbench");
  const effectiveCollapsed = collapsed || canvasRoute || narrowViewport;

  const sidebarWidth = effectiveCollapsed ? 64 : 246;

  function renderSection(section: SidebarSection, index: number) {
    return !effectiveCollapsed ? (
      <section key={section.label} style={{ marginTop: index === 0 ? 0 : 16 }}>
        <div style={{ padding: "0 12px", marginBottom: 6 }}>
          <p className="label-xs" style={{ marginBottom: 2 }}>{section.label}</p>
          <p
            style={{
              margin: 0,
              color: "var(--color-outline)",
              fontSize: "0.625rem",
              lineHeight: 1.25,
              fontWeight: 600,
            }}
          >
            {section.description}
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {section.items.map(item => (
            <NavItem key={item.href} {...item} active={isActive(item.href)} collapsed={false} />
          ))}
        </div>
      </section>
    ) : (
      <section
        key={section.label}
        title={section.label}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          marginTop: index === 0 ? 0 : 8,
          paddingTop: index === 0 ? 0 : 8,
          borderTop: index === 0 ? "none" : "1px solid rgba(106,116,134,0.22)",
        }}
      >
        {section.items.map(item => (
          <NavItem key={item.href} {...item} active={isActive(item.href)} collapsed={true} />
        ))}
      </section>
    );
  }

  return (
    <aside
      className="shell-sidebar"
      style={{
        width: sidebarWidth,
        minWidth: sidebarWidth,
        maxWidth: sidebarWidth,
        flexBasis: sidebarWidth,
      }}
    >

      {/* ── Brand header ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: effectiveCollapsed ? "center" : "space-between",
          gap: effectiveCollapsed ? 0 : 12,
          padding: effectiveCollapsed ? "14px 10px" : "16px 14px 12px",
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
            opacity: effectiveCollapsed ? 0 : 1,
            transition: "opacity 0.2s",
            pointerEvents: effectiveCollapsed ? "none" : "auto",
            width: effectiveCollapsed ? 0 : "auto",
            overflow: "hidden",
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
          <div style={{ minWidth: 0, overflow: "hidden" }}>
            <h2
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "0.9375rem",
                fontWeight: 700,
                color: "var(--color-on-surface)",
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
                // Was 0.18em — rendered "GOVERNED AGENTIC DELIVERY" at
                // ~190px, but the brand-text column inside a 236px sidebar
                // only has ~110px after the logo + collapse button take
                // their share, so it wrapped word-by-word onto three lines.
                // 0.10em keeps the airy microcaps feel and fits one line.
                letterSpacing: "0.10em",
                color: "var(--color-outline)",
                opacity: 0.85,
                marginTop: 2,
                marginBottom: 0,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title="Governed Agentic Delivery"
            >
              Governed Agentic Delivery
            </p>
          </div>
        </div>

        {/* Collapse toggle */}
        <button
          onClick={toggle}
          title={effectiveCollapsed ? (canvasRoute || narrowViewport ? "Compact navigation" : "Expand sidebar") : "Collapse sidebar"}
          disabled={canvasRoute || narrowViewport}
          style={{
            width: 32, height: 32, borderRadius: 8, border: "none",
            background: "var(--color-surface-container)", cursor: canvasRoute || narrowViewport ? "default" : "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--color-primary)", transition: "all 0.15s",
            opacity: canvasRoute || narrowViewport ? 0.55 : 1,
            flexShrink: 0,
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(54,135,39,0.10)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "var(--color-surface-container)"; }}
        >
          {effectiveCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>

      {/* ── Navigation ── */}
      <nav style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "12px 8px" }}>

        {menuSections.map(renderSection)}
      </nav>

      {/* ── Footer ── */}
      {!effectiveCollapsed && (
        <div
          style={{
            padding: "8px 16px 16px",
            borderTop: "1px solid rgba(245,242,234,0.08)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.6875rem",
            color: "var(--color-outline)",
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
