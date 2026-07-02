"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { ChevronDown, ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import {
  advancedRoutes,
  journeyRoutes,
  sidebarSections,
  type NavGroup,
  type RouteMeta,
  type SidebarSection,
} from "@/lib/nav/routes";

const menuSections = sidebarSections();
const journeyItems = journeyRoutes();
const allMenuItems = menuSections.flatMap((section) => section.items);

function NavItem({
  label,
  href,
  icon: Icon,
  active,
  collapsed,
  statusLabel,
}: RouteMeta & { active: boolean; collapsed: boolean }) {
  return (
    <Link href={href} className="block" aria-current={active ? "page" : undefined}>
      <motion.div
        layout
        className={`nav-item${active ? " active" : ""}`}
        title={collapsed ? label : undefined}
        style={collapsed ? { padding: "6px", justifyContent: "center" } : undefined}
      >
        {active && (
          <span
            style={{
              position: "absolute",
              right: 0,
              top: "50%",
              transform: "translateY(-50%)",
              width: 3,
              height: 22,
              borderRadius: "2px 0 0 2px",
              background: "var(--brand-green-accent)",
              boxShadow: "0 0 10px rgba(54,135,39,0.35)",
            }}
          />
        )}
        <span className="nav-icon-well">
          <Icon size={16} />
        </span>
        {!collapsed && (
          <>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
            {statusLabel && (
              <span
                style={{
                  marginLeft: "auto",
                  borderRadius: 999,
                  border: "1px solid rgba(54,135,39,0.18)",
                  background: "rgba(54,135,39,0.07)",
                  color: "var(--color-primary)",
                  padding: "1px 6px",
                  fontSize: 10,
                  fontWeight: 800,
                }}
              >
                {statusLabel}
              </span>
            )}
          </>
        )}
      </motion.div>
    </Link>
  );
}

function SectionHeader({
  section,
  open,
  collapsed,
  onToggle,
}: {
  section: SidebarSection;
  open: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  if (collapsed) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 8,
        border: "none",
        background: "transparent",
        color: "var(--color-outline)",
        cursor: "pointer",
        padding: "5px 10px",
        textAlign: "left",
      }}
    >
      <ChevronDown
        size={14}
        style={{ transform: open ? "none" : "rotate(-90deg)", transition: "transform 0.15s", flexShrink: 0 }}
      />
      <span style={{ minWidth: 0, flex: 1 }}>
        <span className="label-xs" style={{ display: "block", margin: 0 }}>{section.label}</span>
        <span style={{ display: "block", marginTop: 1, fontSize: 10, fontWeight: 600, lineHeight: 1.25 }}>
          {section.description}
        </span>
      </span>
    </button>
  );
}

export function Sidebar() {
  const path = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [narrowViewport, setNarrowViewport] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("sidebar-collapsed");
    if (stored !== null) setCollapsed(stored === "true");
    const storedGroups = localStorage.getItem("sidebar-open-groups");
    if (storedGroups) {
      try {
        setOpenGroups(JSON.parse(storedGroups) as Record<string, boolean>);
      } catch {
        setOpenGroups({});
      }
    }
    const storedAdvanced = localStorage.getItem("sidebar-advanced-open");
    if (storedAdvanced !== null) setAdvancedOpen(storedAdvanced === "true");
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const sync = () => setNarrowViewport(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const matchesHref = (href: string) =>
    href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);

  const activeRoute = useMemo(
    () => allMenuItems
      .filter((item) => matchesHref(item.href))
      .sort((a, b) => b.href.length - a.href.length)[0],
    [path],
  );

  useEffect(() => {
    if (!activeRoute?.group) return;
    setOpenGroups((current) => {
      if (current[activeRoute.group]) return current;
      const next = { ...current, [activeRoute.group]: true };
      localStorage.setItem("sidebar-open-groups", JSON.stringify(next));
      return next;
    });
  }, [activeRoute?.group]);

  function toggle() {
    setCollapsed((current) => {
      const next = !current;
      localStorage.setItem("sidebar-collapsed", String(next));
      return next;
    });
  }

  function toggleGroup(label: NavGroup) {
    setOpenGroups((current) => {
      const next = { ...current, [label]: !current[label] };
      localStorage.setItem("sidebar-open-groups", JSON.stringify(next));
      return next;
    });
  }

  function toggleAdvanced() {
    setAdvancedOpen((current) => {
      const next = !current;
      localStorage.setItem("sidebar-advanced-open", String(next));
      return next;
    });
  }

  const canvasRoute = path.startsWith("/prompt-workbench");
  const effectiveCollapsed = collapsed || canvasRoute || narrowViewport;
  const sidebarWidth = effectiveCollapsed ? 66 : 264;
  const isActive = (href: string) => activeRoute?.href === href;

  function renderSection(section: SidebarSection, index: number) {
    const items = section.items.filter((item) => !item.advanced && item.priority !== "journey");
    if (items.length === 0) return null;
    const open = effectiveCollapsed || openGroups[section.label] || activeRoute?.group === section.label;
    return (
      <section
        key={section.label}
        title={effectiveCollapsed ? section.label : undefined}
        style={{
          marginTop: index === 0 ? 12 : 8,
          paddingTop: index === 0 ? 0 : 8,
          borderTop: index === 0 ? "none" : "1px solid rgba(106,116,134,0.18)",
        }}
      >
        <SectionHeader section={section} open={open} collapsed={effectiveCollapsed} onToggle={() => toggleGroup(section.label)} />
        {open && (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: effectiveCollapsed ? 0 : 4 }}>
            {items.map((item) => (
              <NavItem key={item.href} {...item} active={isActive(item.href)} collapsed={effectiveCollapsed} />
            ))}
          </div>
        )}
      </section>
    );
  }

  function renderAdvanced() {
    const items = advancedRoutes();
    if (items.length === 0) return null;
    const anyActive = items.some((item) => isActive(item.href));
    const open = advancedOpen || anyActive || effectiveCollapsed;
    return (
      <section
        title="Advanced"
        style={{
          marginTop: 10,
          paddingTop: 10,
          borderTop: "1px solid rgba(106,116,134,0.18)",
        }}
      >
        {!effectiveCollapsed && (
          <button
            type="button"
            onClick={toggleAdvanced}
            aria-expanded={open}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              width: "100%",
              padding: "5px 10px",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "var(--color-outline)",
            }}
          >
            <ChevronDown size={14} style={{ transform: open ? "none" : "rotate(-90deg)", transition: "transform 0.15s" }} />
            <span className="label-xs" style={{ margin: 0 }}>Advanced</span>
            <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 800 }}>{items.length}</span>
          </button>
        )}
        {open && (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: effectiveCollapsed ? 0 : 4 }}>
            {items.map((item) => (
              <NavItem key={item.href} {...item} active={isActive(item.href)} collapsed={effectiveCollapsed} />
            ))}
          </div>
        )}
      </section>
    );
  }

  return (
    <aside
      className="shell-sidebar"
      style={{ width: sidebarWidth, minWidth: sidebarWidth, maxWidth: sidebarWidth, flexBasis: sidebarWidth }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: effectiveCollapsed ? "center" : "space-between",
          gap: effectiveCollapsed ? 0 : 12,
          padding: effectiveCollapsed ? "14px 10px" : "16px 14px 12px",
          borderBottom: "1px solid rgba(106,116,134,0.14)",
          flexShrink: 0,
        }}
      >
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
            style={{ flexShrink: 0, filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.16))", userSelect: "none" }}
            onError={(e) => { (e.currentTarget as HTMLImageElement).src = "/singularity-logo.png"; }}
          />
          <div style={{ minWidth: 0, overflow: "hidden" }}>
            <h2 style={{ fontSize: 16, fontWeight: 900, color: "var(--color-on-surface)", letterSpacing: "0.02em", lineHeight: 1.15, margin: 0 }}>
              Singularity
            </h2>
            <p
              title="Agentic SDLC Command Center"
              style={{
                margin: "3px 0 0",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: "var(--color-outline)",
                fontSize: 10,
                fontWeight: 800,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              Agentic SDLC Command Center
            </p>
          </div>
        </div>

        <button
          onClick={toggle}
          title={effectiveCollapsed ? (canvasRoute || narrowViewport ? "Compact navigation" : "Expand sidebar") : "Collapse sidebar"}
          disabled={canvasRoute || narrowViewport}
          className="btn-secondary"
          style={{
            width: 32,
            height: 32,
            padding: 0,
            justifyContent: "center",
            opacity: canvasRoute || narrowViewport ? 0.55 : 1,
            flexShrink: 0,
          }}
        >
          {effectiveCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>

      <nav style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "10px 8px" }}>
        <section className={effectiveCollapsed ? "" : "journey-rail"} title="Primary SDLC journey">
          {!effectiveCollapsed && (
            <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "2px 4px 8px", color: "var(--color-primary)" }}>
              <Sparkles size={14} />
              <span className="label-xs" style={{ margin: 0, color: "var(--color-primary)" }}>Primary Journey</span>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {journeyItems.map((item) => (
              <NavItem key={item.href} {...item} active={isActive(item.href)} collapsed={effectiveCollapsed} />
            ))}
          </div>
        </section>

        {menuSections.map(renderSection)}
        {renderAdvanced()}
      </nav>

      {!effectiveCollapsed && (
        <div
          style={{
            padding: "9px 14px 15px",
            borderTop: "1px solid rgba(106,116,134,0.14)",
            color: "var(--color-outline)",
            fontSize: 11,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          v1.0.0 · unified web
        </div>
      )}
    </aside>
  );
}
