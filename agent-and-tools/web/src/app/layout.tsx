import type { Metadata } from "next";
import "./globals.css";
import { PlatformShell } from "@/components/ui/PlatformShell";

export const metadata: Metadata = {
  title: "Singularity Platform",
  description: "Unified platform web app for operations, agents, workflows, workbench, foundry, and identity.",
  icons: { icon: "/favicon.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <PlatformShell>{children}</PlatformShell>
      </body>
    </html>
  );
}
