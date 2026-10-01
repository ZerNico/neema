import { useRouterState } from "@tanstack/react-router";

/**
 * Who a page belongs to: the chat on screen, or else the page itself, so a new
 * chat or a project page can browse too. Read from the rendered route, like the
 * panel's own tab scope, so both change together.
 */
export function useBrowserOwner(): string {
  return useRouterState({
    select: (state) => {
      const leaf = state.matches[state.matches.length - 1];
      const params: Record<string, unknown> = leaf?.params ?? {};
      return typeof params.conversationId === "string"
        ? params.conversationId
        : `page:${leaf?.pathname ?? state.location.pathname}`;
    },
  });
}
