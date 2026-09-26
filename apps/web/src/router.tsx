import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { getGlobalStartContext } from "@tanstack/react-start";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { routeTree } from "./routeTree.gen";
import { RouteError, RouteNotFound } from "./ui/route-error.tsx";
import { StartupPending } from "./ui/startup-pending.tsx";

export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
      },
    },
  });

  const nonce = getGlobalStartContext()?.cspNonce;
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: StartupPending,
    // Root sets these too: a document-level failure never sees the defaults.
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: RouteNotFound,
    defaultPendingMinMs: 0,
    // Server only; the client reads it back from the `csp-nonce` meta tag.
    ...(nonce === undefined ? {} : { ssr: { nonce } }),
  });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module "@tanstack/react-router" {
  interface HistoryState {
    chatPrefill?: string;
    /** Set by the new-chat page on the chat it just started, so its first turn is anchored. */
    anchorNewTurn?: true;
  }
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
