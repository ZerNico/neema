import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { authClient } from "./client.ts";
import { getSessionIdentity } from "./server/functions.ts";
import { projectSessionIdentity, sameIdentity, type SessionIdentity } from "./identity.ts";
import { Button } from "~/ui/primitives/button";

export const IDENTITY_CHANGE_KEY = "chat.identity-change";
export const identityNavigation = { replace: (path: string) => window.location.replace(path) };
type Destination = "/" | "/admin/users" | "/login";
interface IdentityBoundaryActions {
  reconcile: () => Promise<boolean>;
  changeIdentity: (operation: () => Promise<void>, destination: Destination) => Promise<void>;
}
const IdentityContext = createContext<IdentityBoundaryActions | null>(null);
export const useIdentityBoundary = () => useContext(IdentityContext);

export function IdentityBoundary({
  identity,
  children,
}: {
  identity: SessionIdentity;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [initialIdentity] = useState(identity);
  const [leaving, setLeaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const state = useRef({
    leaving: false,
    mutating: false,
    disposed: false,
    epoch: 0,
    check: null as Promise<boolean> | null,
  });

  const replace = useCallback(
    (destination: Destination, broadcast: boolean) => {
      if (state.current.leaving || state.current.disposed) return;
      state.current.leaving = true;
      // Commit stream cleanup before clearing caches or replacing the document.
      flushSync(() => setLeaving(true));
      void queryClient.cancelQueries();
      queryClient.clear();
      if (broadcast) {
        try {
          localStorage.setItem(IDENTITY_CHANGE_KEY, crypto.randomUUID());
        } catch {
          /* Focus checks cover unavailable storage. */
        }
      }
      identityNavigation.replace(destination);
    },
    [queryClient],
  );

  const reconcile = useCallback((): Promise<boolean> => {
    const current = state.current;
    if (current.leaving || current.disposed || current.mutating) return Promise.resolve(false);
    if (current.check) return current.check;
    const epoch = current.epoch;
    current.check = getSessionIdentity()
      .then((next) => {
        if (current.leaving || current.disposed || current.mutating || epoch !== current.epoch)
          return false;
        if (!sameIdentity(initialIdentity, next)) {
          replace(next ? "/" : "/login", false);
          return false;
        }
        setChecking(false);
        setFailed(false);
        return true;
      })
      .catch(() => {
        if (!current.disposed && !current.leaving && epoch === current.epoch) setFailed(true);
        return false; // A transport error is not a logout.
      })
      .finally(() => {
        if (epoch === current.epoch) current.check = null;
      });
    return current.check;
  }, [initialIdentity, replace]);

  const changeIdentity = useCallback(
    (operation: () => Promise<void>, destination: Destination): Promise<void> => {
      const current = state.current;
      if (current.mutating || current.leaving || current.disposed) return Promise.resolve();
      current.mutating = true;
      current.epoch++;
      current.check = null;
      return Promise.resolve()
        .then(operation)
        .then(() => {
          replace(destination, true);
        })
        .finally(() => {
          current.mutating = false;
        });
    },
    [replace],
  );

  useEffect(() => {
    const current = state.current;
    current.disposed = false;
    const check = () => {
      void reconcile();
    };
    const resume = () => {
      if (
        document.visibilityState === "hidden" ||
        current.mutating ||
        current.leaving ||
        current.disposed
      )
        return;
      setChecking(true);
      check();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === IDENTITY_CHANGE_KEY && event.newValue) replace("/", false);
    };
    const pagehide = () => {
      // Hide synchronously in the BFCache snapshot, before React gets another paint.
      current.epoch++;
      current.check = null;
      flushSync(() => setChecking(true));
    };
    const pageshow = (event: PageTransitionEvent) => {
      if (event.persisted) resume();
    };
    const nativeChange = () => {
      if (current.mutating) return;
      current.epoch++;
      current.check = null;
      resume();
    };
    const unsubscribe = authClient.$store.atoms.$sessionSignal!.listen(nativeChange);
    const unsubscribeSession = authClient.$store.atoms.session!.listen((value) => {
      // Unresolved hydration and transport failures never establish a new identity.
      if (
        !value.isPending &&
        !value.error &&
        !sameIdentity(initialIdentity, projectSessionIdentity(value.data))
      )
        nativeChange();
    });
    window.addEventListener("storage", storage);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("pageshow", pageshow);
    check();
    return () => {
      current.disposed = true;
      current.epoch++;
      current.check = null;
      unsubscribe();
      unsubscribeSession();
      window.removeEventListener("storage", storage);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pagehide", pagehide);
      window.removeEventListener("pageshow", pageshow);
    };
  }, [initialIdentity, reconcile, replace]);

  const changedRouteIdentity = !sameIdentity(initialIdentity, identity);
  useEffect(() => {
    if (changedRouteIdentity) queueMicrotask(() => replace("/", false));
  }, [changedRouteIdentity, replace]);

  const actions = useMemo(() => ({ reconcile, changeIdentity }), [reconcile, changeIdentity]);
  return (
    <IdentityContext.Provider value={actions}>
      {leaving || changedRouteIdentity ? (
        <p role="status" className="p-4">
          Changing session…
        </p>
      ) : (
        <>
          {checking && (
            <div className="p-4" role="status">
              {failed ? (
                <>
                  Could not verify your session.{" "}
                  <Button variant="outline" onClick={() => void reconcile()}>
                    Retry
                  </Button>
                </>
              ) : (
                "Checking session…"
              )}
            </div>
          )}
          {/* Activity also hides portals and cleans up subscriptions, while preserving
              drafts across a focus check. A verified change unmounts it permanently. */}
          <Activity mode={checking ? "hidden" : "visible"}>{children}</Activity>
        </>
      )}
    </IdentityContext.Provider>
  );
}
