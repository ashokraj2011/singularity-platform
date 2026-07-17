"use client";

import { useEffect, useState } from "react";

export function useLocalWorkspace<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(initialValue);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      setValue(stored ? JSON.parse(stored) as T : initialValue);
    } catch {
      setValue(initialValue);
    }
    setLoadedKey(key);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (loadedKey !== key) return;
    window.localStorage.setItem(key, JSON.stringify(value));
  }, [key, loadedKey, value]);

  return [value, setValue, loadedKey === key] as const;
}
