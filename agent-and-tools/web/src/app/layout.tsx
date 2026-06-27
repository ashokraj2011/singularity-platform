import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/AppShell";

export const metadata: Metadata = {
  title: "Singularity Platform",
  description: "Unified platform web app for operations, agents, workflows, and identity.",
  icons: { icon: "/favicon.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Chrome (sidebar/topbar/padded main) lives in the client AppShell so it can
  // drop to full-bleed for the in-process /workbench cockpit via usePathname().
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
