import { useEffect, useState } from "react";
import { serverNow } from "../client/use-message-stream.ts";

/** A clock that ticks once a second while `running`; elapsed from `since`. */
export function useElapsed(since: number, running: boolean) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(serverNow()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return Math.max(0, now - since);
}
