"use client";

/**
 * "Open in Working Session" — a project-aware launcher into the full 3-pane co-authoring
 * session (/synthesis/session). Mounted once in the SynthesisShell workbar so every synthesis
 * screen offers it without editing each screen; it self-hides when no initiative is selected
 * or when already on the session page. Carries ?project= so the session opens on the same
 * initiative the user is looking at.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PenLine } from "lucide-react";
import { useSelectedProjectId } from "../ProjectPicker";

export function OpenInWorkingSessionButton() {
  const projectId = useSelectedProjectId();
  const pathname = usePathname() ?? "";
  if (!projectId || pathname.startsWith("/synthesis/session")) return null;
  return (
    <Link
      href={`/synthesis/session?project=${encodeURIComponent(projectId)}`}
      title="Open a full Working Session for this initiative"
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-outline-variant bg-surface-container-lowest px-2.5 text-xs font-bold text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
    >
      <PenLine size={14} />
      <span className="hidden md:inline">Open in Working Session</span>
    </Link>
  );
}
