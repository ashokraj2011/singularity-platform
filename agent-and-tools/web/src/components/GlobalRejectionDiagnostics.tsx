"use client";

import { useEffect } from "react";

/**
 * Diagnostics for the confusing class of unhandled promise rejections that surface as
 * "[object Event]" — a promise rejected with a DOM `Event` (a failed resource/chunk load, an
 * EventSource/WebSocket error, or a media/FileReader error) instead of an `Error`. Next's dev
 * overlay stringifies the Event to "[object Event]" with an unusable, all-internal stack.
 *
 * This listener does NOT swallow anything (no preventDefault) — the overlay still fires, so a
 * real problem is never hidden — but it logs a readable, source-pointing line to the console so
 * the actual origin (Event type + target URL) is identifiable on the very next occurrence.
 */
function describeReason(reason: unknown): string | null {
  if (reason instanceof Error) return null; // real Errors already print with a useful stack
  if (typeof Event !== "undefined" && reason instanceof Event) {
    const target = reason.target as Partial<{ nodeName: string; src: string; href: string; url: string; readyState: number }> | null;
    const where = target ? [target.nodeName, target.src ?? target.href ?? target.url].filter(Boolean).join(" ") : "";
    return (
      `promise rejected with a DOM Event (type="${reason.type}"${where ? `, target=${where}` : ""}). ` +
      "Usual causes: a failed resource/chunk load (a stale dev build — hard-refresh or restart the dev server), " +
      "an EventSource/WebSocket error, or a media/FileReader error — not a JS exception."
    );
  }
  try {
    return `promise rejected with a non-Error value (${typeof reason}): ${JSON.stringify(reason)}`;
  } catch {
    return `promise rejected with a non-Error value of type ${typeof reason}`;
  }
}

export function GlobalRejectionDiagnostics() {
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      const detail = describeReason(event.reason);
      if (detail) console.error(`[unhandled-rejection] ${detail}`, event.reason);
    };
    window.addEventListener("unhandledrejection", onRejection);
    return () => window.removeEventListener("unhandledrejection", onRejection);
  }, []);
  return null;
}
