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
const sidebarGroupLabels = new Set<NavGroup>(menuSections.map((section) => section.label));

function parseStoredBoolean(raw: string | null, fallback: boolean): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseStoredOpenGroups(raw: string | null): Record<string, boolean> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};
    const next: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (sidebarGroupLabels.has(key as NavGroup) && typeof value === "boolean") {
        next[key] = value;
      }
    }
    return next;
  } catch {
    return {};
  }
}

function NavItem({
  label,
  href,
  icon: Icon,
  active,
  collapsed,
  statusLabel,
  surfaceType,
}: RouteMeta & { active: boolean; collapsed: boolean }) {
  const accent = surfaceAccent(surfaceType);
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
              background: accent.fg,
              boxShadow: `0 0 10px ${accent.glow}`,
            }}
          />
        )}
        <span
          className="nav-icon-well"
          style={active ? { background: accent.bg, color: accent.fg } : undefined}
        >
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
                  border: `1px solid ${accent.border}`,
                  background: accent.bg,
                  color: accent.fg,
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

function surfaceAccent(surfaceType?: RouteMeta["surfaceType"]): { fg: string; bg: string; border: string; glow: string } {
  switch (surfaceType) {
    case "agent":
      return { fg: "var(--accent-agent)", bg: "var(--accent-agent-soft)", border: "rgba(124,58,237,0.20)", glow: "rgba(124,58,237,0.28)" };
    case "runtime":
    case "operation":
      return { fg: "var(--accent-runtime)", bg: "var(--accent-runtime-soft)", border: "rgba(8,145,178,0.22)", glow: "rgba(8,145,178,0.28)" };
    case "identity":
      return { fg: "var(--accent-identity)", bg: "var(--accent-identity-soft)", border: "rgba(71,85,105,0.22)", glow: "rgba(71,85,105,0.24)" };
    case "governance":
      return { fg: "var(--accent-evidence)", bg: "var(--accent-evidence-soft)", border: "rgba(217,119,6,0.22)", glow: "rgba(217,119,6,0.28)" };
    case "workflow":
      return { fg: "var(--accent-workflow)", bg: "var(--accent-workflow-soft)", border: "rgba(37,99,235,0.22)", glow: "rgba(37,99,235,0.28)" };
    case "knowledge":
      return { fg: "var(--accent-runtime)", bg: "var(--accent-runtime-soft)", border: "rgba(8,145,178,0.22)", glow: "rgba(8,145,178,0.28)" };
    case "launch":
    default:
      return { fg: "var(--accent-workflow)", bg: "var(--accent-workflow-soft)", border: "rgba(37,99,235,0.22)", glow: "rgba(37,99,235,0.28)" };
  }
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
    setCollapsed((current) => parseStoredBoolean(localStorage.getItem("sidebar-collapsed"), current));
    setOpenGroups(parseStoredOpenGroups(localStorage.getItem("sidebar-open-groups")));
    setAdvancedOpen((current) => parseStoredBoolean(localStorage.getItem("sidebar-advanced-open"), current));
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
          // Match the topbar height (52px) exactly so the sidebar-header divider
          // lines up with the topbar's bottom border. box-sizing:border-box (from
          // Tailwind preflight) means the 1px border is included in the 52px.
          height: 52,
          boxSizing: "border-box",
          padding: effectiveCollapsed ? "0 10px" : "0 14px",
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
          <div style={{ minWidth: 0, overflow: "hidden" }}>
            <h2 style={{ fontSize: 16, fontWeight: 900, color: "var(--color-on-surface)", lineHeight: 1.15, margin: 0 }}>
              Singularity
            </h2>
            <p
              title="Agentic SDLC Command Center"
              style={{
                margin: "3px 0 0",
                overflow: "hidden",
                whiteSpace: "normal",
                color: "var(--color-outline)",
                fontSize: 11,
                fontWeight: 800,
                lineHeight: 1.2,
                textTransform: "none",
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
            <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "2px 4px 8px", color: "var(--accent-workflow)" }}>
              <Sparkles size={14} />
              <span className="label-xs" style={{ margin: 0, color: "var(--accent-workflow)" }}>Primary Journey</span>
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
