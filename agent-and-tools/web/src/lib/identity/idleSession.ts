"use client";

/**
 * Client-side idle-session timeout.
 *
 * The IAM JWT is long-lived (12h) and stored in localStorage, so it survives app
 * restarts and long idle gaps — by itself it never forces a re-login. This adds an
 * activity deadline: after `idleLimitMs()` with no user interaction, the front-door
 * gate (RequireSession) clears the session and shows sign-in.
 *
 * The deadline is stored in localStorage (not memory) so it is shared across tabs
 * and survives a reload — reopening the tab after the deadline still logs out.
 */
import { hasAgentToolsToken, SESSION_LAST_ACTIVITY_KEY } from "@/lib/api";

const DEFAULT_IDLE_MINUTES = 30;
const MIN_IDLE_MINUTES = 1;
const MAX_IDLE_MINUTES = 12 * 60;

export function boundedIdleMinutes(raw = process.env.NEXT_PUBLIC_SESSION_IDLE_MINUTES): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_IDLE_MINUTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_IDLE_MINUTES) return DEFAULT_IDLE_MINUTES;
  return Math.min(MAX_IDLE_MINUTES, Math.trunc(parsed));
}

/** Idle window in ms. Override with NEXT_PUBLIC_SESSION_IDLE_MINUTES. */
export function idleLimitMs(): number {
  return boundedIdleMinutes() * 60_000;
}

/** DOM events that count as "the user is still here" and push the deadline forward. */
export const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "scroll", "touchstart"] as const;

export function markActivity(when: number = Date.now()): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SESSION_LAST_ACTIVITY_KEY, String(when));
  } catch {
    /* ignore storage quota / privacy-mode errors */
  }
}

function lastActivityAt(): number | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(SESSION_LAST_ACTIVITY_KEY);
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : null;
}

/**
 * True when a session token exists but the last recorded activity is older than the
 * idle limit. False when signed out, or when no activity has been stamped yet
 * (a brand-new sign-in — saveAgentToolsToken stamps it immediately).
 */
export function isIdleExpired(now: number = Date.now()): boolean {
  if (!hasAgentToolsToken()) return false;
  const last = lastActivityAt();
  if (last === null) return false;
  return now - last > idleLimitMs();
}
