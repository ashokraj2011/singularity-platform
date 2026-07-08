"use client";

/**
 * Per-user menu favorites — pinned routes for quick access at the top of the
 * sidebar. Persisted in localStorage (`sidebar-favorites`), matching the rest of
 * the sidebar's client-side preferences (collapsed / open-groups / advanced).
 * Backed by useSyncExternalStore so the star toggle on a nav item and the
 * Favorites section re-render together, and it stays in sync across browser tabs.
 *
 * Favorites store route `id`s (stable; see ROUTES) — resolved back to RouteMeta
 * for rendering, so a removed/renamed route simply drops out.
 */
import { useCallback, useSyncExternalStore } from "react";
import { ROUTES, type RouteMeta } from "./routes";

const KEY = "sidebar-favorites";
const EMPTY: string[] = [];

let cache: string[] | null = null;
const listeners = new Set<() => void>();

function read(): string[] {
  if (cache) return cache;
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    cache = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(next: string[]): void {
  cache = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable (private mode / quota) — keep in-memory only */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      cache = null; // another tab changed it → re-read on next snapshot
      cb();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function useFavorites() {
  // getServerSnapshot returns the stable EMPTY so SSR + first paint agree; the
  // real list swaps in after hydration (same post-mount pattern the sidebar uses).
  const favoriteIds = useSyncExternalStore(subscribe, read, () => EMPTY);

  const isFavorite = useCallback((id: string) => favoriteIds.includes(id), [favoriteIds]);

  const toggleFavorite = useCallback((id: string) => {
    const current = read();
    write(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  }, []);

  // Resolve ids → RouteMeta in the user's saved order; drop unknown ids.
  const favoriteRoutes = favoriteIds
    .map((id) => ROUTES.find((r) => r.id === id))
    .filter((r): r is RouteMeta => Boolean(r));

  return { favoriteIds, favoriteRoutes, isFavorite, toggleFavorite };
}
