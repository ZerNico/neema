import { useEffect } from "react";
import { refreshDesktopSession } from "~/modules/auth/client.ts";
import { useDesktopAuth } from "~/modules/desktop/client/bridge.ts";

/**
 * Extends the desktop session on every launch. Better Auth's own refresh
 * would cut it back to the browser lifetime, so the 90 days are renewed by
 * this explicit call, once per authenticated mount and only inside the shell.
 * A failure is not the reader's problem: the session is still valid today.
 */
export function useDesktopSessionRefresh(): void {
  const auth = useDesktopAuth();
  useEffect(() => {
    if (!auth) return;
    refreshDesktopSession().catch((error: unknown) => {
      console.error("Could not extend the desktop session.", error);
    });
  }, [auth]);
}
