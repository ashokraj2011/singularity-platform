"use client";

import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { NAV_GROUPS, ROUTES } from "@/lib/nav/routes";

/**
 * ⌘K / Ctrl-K command palette. Sourced entirely from the shared route registry
 * (src/lib/nav/routes.ts) so it can never drift from the sidebar. cmdk handles
 * fuzzy filtering (on each item's `value`), keyboard nav, and a11y; styling is in
 * globals.css via the [cmdk-*] data attributes. Controlled by AppShell.
 */
export function CommandPalette({
  open, onOpenChange,
}: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();

  function go(href: string) {
    onOpenChange(false);
    router.push(href);
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Search pages"
      overlayClassName="cmdk-overlay"
      contentClassName="cmdk-dialog"
    >
      <Command.Input autoFocus placeholder="Jump to… (e.g. capabilities, runs, identity)" />
      <Command.List>
        <Command.Empty>No matching page.</Command.Empty>
        {NAV_GROUPS.map((group) => {
          const items = ROUTES
            .filter((r) => r.group === group.label)
            .sort((a, b) => {
              const rank = { journey: 0, primary: 1, secondary: 2, admin: 3 } as const;
              return (rank[a.priority ?? "secondary"] ?? 2) - (rank[b.priority ?? "secondary"] ?? 2);
            });
          if (items.length === 0) return null;
          return (
            <Command.Group key={group.label} heading={group.label}>
              {items.map((route) => {
                const Icon = route.icon;
                return (
                  <Command.Item
                    key={route.id}
                    // cmdk filters on this value — include label, group, path, and
                    // keywords so search matches any of them.
                    value={`${route.label} ${route.group} ${route.href} ${(route.keywords ?? []).join(" ")}`}
                    onSelect={() => go(route.href)}
                  >
                    <Icon size={15} aria-hidden />
                    <span>{route.label}</span>
                    {route.statusLabel && <span className="cmdk-item-href">{route.statusLabel}</span>}
                    <span className="cmdk-item-href">{route.href}</span>
                  </Command.Item>
                );
              })}
            </Command.Group>
          );
        })}
      </Command.List>
    </Command.Dialog>
  );
}
