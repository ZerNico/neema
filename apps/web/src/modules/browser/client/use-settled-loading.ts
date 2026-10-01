import { useEffect, useState } from "react";

/**
 * Loading as a person should see it: on at once, off only once it has stayed
 * off a moment. Pages like Google stop and start loading several times as they
 * finish, which would flick a stop button back and forth.
 */
export function useSettledLoading(loading: boolean, delayMs = 400): boolean {
  const [settled, setSettled] = useState(loading);
  if (loading && !settled) setSettled(true);
  useEffect(() => {
    if (loading || !settled) return;
    const timer = setTimeout(() => setSettled(false), delayMs);
    return () => clearTimeout(timer);
  }, [loading, settled, delayMs]);
  return settled;
}
