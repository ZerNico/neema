import { useCallback, useSyncExternalStore } from "react";

/**
 * A choice about this computer's browser, kept with the app on this machine
 * rather than on the account, and shared by every open window of it.
 */
export function localPreference<T extends string>(
  key: string,
  values: ReadonlyArray<T>,
  fallback: T,
) {
  const listeners = new Set<() => void>();
  const read = (): T => {
    try {
      const stored = localStorage.getItem(key);
      return values.find((value) => value === stored) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) listener();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  };
  const write = (next: T) => {
    try {
      localStorage.setItem(key, next);
    } catch {
      // Without storage the choice lasts until the page reloads.
    }
    for (const listener of listeners) listener();
  };
  const use = () => {
    const value = useSyncExternalStore(subscribe, read, read);
    return [value, useCallback(write, [])] as const;
  };
  return { read, use };
}
