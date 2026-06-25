import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/ui/Sidebar";
import { EventHorizonChat } from "@/components/EventHorizonChat";
import { AppSwitcher } from "@/components/AppSwitcher";
import { LogoutButton } from "@/components/LogoutButton";
import { Bell, Settings } from "lucide-react";

export const metadata: Metadata = {
  title: "Singularity Platform",
  description: "Unified platform web app for operations, agents, workflows, and identity.",
  icons: { icon: "/favicon.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>

          {/* Sidebar — sticky, participates in flex flow */}
          <Sidebar />

          {/* Right column */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

            {/* ── Topbar ── */}
            <header
              className="shell-topbar"
              style={{
                height: 52,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0 20px",
              }}
            >
              {/* Workspace badge */}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "4px 10px",
                    borderRadius: 20,
                    border: "1px solid rgba(54,135,39,0.18)",
                    background: "rgba(54,135,39,0.06)",
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.14em",
                    color: "var(--color-primary)",
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "var(--color-primary)",
                      flexShrink: 0,
                    }}
                  />
                  Platform Web
                </span>
              </div>

              {/* Actions */}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <AppSwitcher />
                <button
                  style={{
                    width: 32, height: 32, borderRadius: 10,
                    border: "1px solid var(--color-outline-variant)",
                    background: "transparent", cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "var(--color-outline)", transition: "all 0.15s",
                  }}
                  aria-label="Notifications"
                >
                  <Bell size={15} />
                </button>
                <button
                  style={{
                    width: 32, height: 32, borderRadius: 10,
                    border: "1px solid var(--color-outline-variant)",
                    background: "transparent", cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "var(--color-outline)", transition: "all 0.15s",
                  }}
                  aria-label="Settings"
                >
                  <Settings size={15} />
                </button>
                <LogoutButton />
              </div>
            </header>

            {/* ── Page content ── */}
            <main
              style={{
                flex: 1,
                overflow: "auto",
                padding: "2rem",
                background: "var(--color-surface)",
              }}
            >
              {children}
            </main>
          </div>
          <EventHorizonChat />
        </div>
      </body>
    </html>
  );
}
