import { useQueryClient } from "@tanstack/react-query";
import { Activity, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { clearDeviceCaches, setDeviceCacheOwner } from "~/modules/cache/client/device-cache.ts";
import { authClient } from "./client.ts";
import { isNotApprovedError } from "./signup.ts";
import { getSessionIdentity } from "./server/functions.ts";
import {
  cacheOwnerOf,
  isUnauthenticatedError,
  projectSessionIdentity,
  sameIdentity,
  type SessionIdentity,
} from "./identity.ts";
import {
  IDENTITY_CHANGE_KEY,
  identityNavigation,
  IdentityContext,
  type Destination,
} from "./identity-context.ts";

/**
 * Guards one signed-in identity for the lifetime of the authenticated tree.
 *
 * The tree is rendered for `initialIdentity` and nothing else: cached queries,
 * open streams and drafts all belong to that account, so a different one must
 * never render into them. When the identity changes, the whole tree is torn
 * down, caches are cleared and the document is replaced, never patched.
 *
 * Detection is layered, cheapest and most authoritative first:
 * 1. A `401` from any server function ends the session on the spot: the
 *    server said so, no confirmation round trip needed.
 * 2. In-app changes (sign-out, impersonation) go through `changeIdentity`,
 *    which broadcasts to sibling tabs over `localStorage`; Better Auth's own
 *    session signal covers its native flows.
 * 3. A silent revalidation on focus/visibility return catches what neither
 *    sees: a cookie expired or cleared outside the app while the tab slept.
 *
 * Only (3) is speculative, so it never hides anything. Concealing the app
 * before the check answers would blank it on every tab return, and via
 * `<Activity>` it also detaches host refs, which Motion treats as a remount
 * and replays every entrance animation on screen. The one exception is the
 * BFCache snapshot: `pagehide` hides synchronously because the frozen page
 * can be shown again without any script running first.
 */
/** How long leaving waits for the device cache to be cleared. */
const CLEAR_WAIT_MS = 500;

export function IdentityBoundary({
  identity,
  children,
}: {
  identity: SessionIdentity;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [initialIdentity] = useState(identity);
  const cacheOwner = cacheOwnerOf(initialIdentity);
  useEffect(() => setDeviceCacheOwner(cacheOwner), [cacheOwner]);
  const [leaving, setLeaving] = useState(false);
  const [frozen, setFrozen] = useState(false);
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
      // What this device kept for the identity leaving goes with it. Replacing
      // the document can abort a clear still in flight, so the (already hidden)
      // tree waits for it, briefly: a clear that hangs must not trap the reader.
      const cleared = Promise.race([
        clearDeviceCaches(),
        new Promise((done) => setTimeout(done, CLEAR_WAIT_MS)),
      ]);
      if (broadcast) {
        try {
          localStorage.setItem(IDENTITY_CHANGE_KEY, crypto.randomUUID());
        } catch {
          /* Focus checks cover unavailable storage. */
        }
      }
      void cleared.finally(() => identityNavigation.replace(destination));
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
        setFrozen(false);
        return true;
      })
      .catch((error: unknown) => {
        if (current.disposed || current.leaving || epoch !== current.epoch) return false;
        // The server refusing the check *is* the answer; a transport error is not.
        if (isUnauthenticatedError(error)) replace("/login", false);
        return false;
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

  // Layer 1: any request the server refuses ends the session immediately, and
  // one refused for an account turned down or waiting again shows the wait.
  useEffect(() => {
    const onError = (error: unknown) => {
      if (state.current.mutating) return;
      if (isUnauthenticatedError(error)) replace("/login", false);
      else if (isNotApprovedError(error)) replace("/pending", false);
    };
    const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") onError(event.action.error);
    });
    const unsubscribeMutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") onError(event.action.error);
    });
    return () => {
      unsubscribeQueries();
      unsubscribeMutations();
    };
  }, [queryClient, replace]);

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
      check();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === IDENTITY_CHANGE_KEY && event.newValue) replace("/", false);
    };
    const pagehide = () => {
      // Hide synchronously in the BFCache snapshot, before React gets another paint.
      current.epoch++;
      current.check = null;
      flushSync(() => setFrozen(true));
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
          {frozen && (
            <p className="p-4" role="status">
              Checking session…
            </p>
          )}
          {/* Hidden only across a BFCache round trip; a live tab is never blanked. */}
          <Activity mode={frozen ? "hidden" : "visible"}>{children}</Activity>
        </>
      )}
    </IdentityContext.Provider>
  );
}
