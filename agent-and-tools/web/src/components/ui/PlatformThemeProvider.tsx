"use client";

import type { ReactNode } from "react";
import { ThemeProvider } from "next-themes";

export function PlatformThemeProvider({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="data-theme"
      defaultTheme="current"
      enableSystem={false}
      themes={["current", "green"]}
    >
      {children}
    </ThemeProvider>
  );
}
