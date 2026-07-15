import { ideTokens, type IdeTheme } from "workgraph-web/features/runtime/workitem/ideTheme";

/**
 * projectIdeTokens — bridges the Studio project surfaces (which consume var(--studio-*)) onto the
 * shared Work Item IDE palette. Spreads ideTokens(theme) (--ide-* chrome + re-skinned --color-*) and
 * aliases every --studio-* token the ProjectxSurface components use to the matching spruce IDE value,
 * for both light and dark. Result: the existing project surfaces render inside IdeShell in the same
 * palette as the Work Item IDE and respond to the light/dark toggle — with zero changes to them.
 */
export function projectIdeTokens(theme: IdeTheme): Record<string, string> {
  const dark = theme === "dark";
  return {
    ...ideTokens(theme),
    "--studio-bg": dark ? "#0e1411" : "#eef2f0",
    "--studio-chrome": dark ? "#121a15" : "#f6f9f7",
    "--studio-panel": dark ? "#0c120f" : "#ffffff",
    "--studio-panel-2": dark ? "#16201b" : "#ffffff",
    "--studio-elev": dark ? "#18221c" : "#eaf0ec",
    "--studio-line": dark ? "#1e2a23" : "#dce4e0",
    "--studio-line-2": dark ? "#24302a" : "#dde5e1",
    "--studio-line-soft": dark ? "#172019" : "#e7ede9",
    "--studio-ink": dark ? "#d9e2dc" : "#101a16",
    "--studio-ink-dim": dark ? "#9fb0a7" : "#3a4a42",
    "--studio-muted": dark ? "#74877d" : "#64756c",
    "--studio-faint": dark ? "#566258" : "#93a199",
    "--studio-accent": dark ? "#46c39d" : "#16745b",
    "--studio-accent-2": dark ? "#bff0e0" : "#0c4436",
    "--studio-accent-soft": dark ? "#12271f" : "#e2efe9",
    "--studio-accent-line": dark ? "rgba(70,195,157,0.35)" : "rgba(22,116,91,0.30)",
    "--studio-accent-ink": dark ? "#06120d" : "#ffffff",
    "--studio-live": dark ? "#4bc489" : "#2e9e6b",
    "--studio-live-soft": "rgba(75,196,137,0.14)",
    "--studio-good": dark ? "#4bc489" : "#2e9e6b",
    "--studio-good-soft": "rgba(75,196,137,0.14)",
    "--studio-warn": dark ? "#d7a13f" : "#b7811f",
    "--studio-warn-soft": "rgba(215,161,63,0.14)",
    "--studio-bad": dark ? "#e0685c" : "#c24a3f",
    "--studio-bad-soft": "rgba(224,104,92,0.14)",
    "--studio-p1": "#46c39d",
    "--studio-p2": "#f0a35e",
    "--studio-p3": "#5ab0f0",
    "--studio-p4": "#e0685c",
    "--studio-p5": "#b98be0",
    "--studio-p6": "#d7a13f",
    "--studio-mono": 'ui-monospace, "SF Mono", "JetBrains Mono", "Fira Code", monospace',
    "--studio-shadow": dark
      ? "0 1px 2px rgba(0,0,0,0.4), 0 8px 24px -14px rgba(0,0,0,0.6)"
      : "0 1px 2px rgba(16,26,22,0.06), 0 8px 24px -14px rgba(16,26,22,0.18)",
  };
}
