import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";
import { useDetailPanel, useDetailPanelTabIds } from "~/ui/detail-panel-context.ts";
import { useIsMobile } from "~/ui/use-mobile.ts";
import { appViewOpenRequests, usePendingAppViewOpen } from "../client/open-requests.ts";
import { appViewSpells, useAppView, useDesktopAppUse } from "../client/use-app-view.ts";
import { APP_VIEW_PREFIX, appViewRequest } from "./app-view-request.tsx";

const { opened, closed } = appViewSpells;

/**
 * What each chat's tab stops now. The chat rebuilds its stop with every render; reading it from
 * here keeps the tab's request, and so the panel, still while answers come and go.
 */
const stops = new Map<string, () => void>();

/**
 * Keeps a chat's live view of app use on its panel tab. Opens it when a spell of app use
 * starts while the chat is on screen, adds it back unselected when the person returns during
 * one, and opens it when the floating window sends them back. Never on a phone, where the panel
 * covers the answer, and only in the desktop app on a Mac.
 */
export function AppViewOwner({
  conversationId,
  stop,
}: {
  conversationId: string;
  /** Ends the answer running here; absent when none does. */
  stop: (() => void) | undefined;
}) {
  const appUse = useDesktopAppUse();
  const panel = useDetailPanel();
  const tabIds = useDetailPanelTabIds();
  const isMobile = useIsMobile();
  const view = useAppView(conversationId);
  const pendingOpen = usePendingAppViewOpen();
  const id = `${APP_VIEW_PREFIX}${conversationId}`;
  const present = tabIds.includes(id);

  useEffect(() => {
    if (!stop) return;
    stops.set(conversationId, stop);
    return () => {
      if (stops.get(conversationId) === stop) stops.delete(conversationId);
    };
  }, [conversationId, stop]);
  const stoppable = stop !== undefined;
  const app = view?.app ?? "";
  const busy = view?.busy ?? false;
  const request = useMemo(
    () =>
      appViewRequest({
        conversationId,
        app,
        busy,
        stop: stoppable ? () => stops.get(conversationId)?.() : undefined,
      }),
    [conversationId, app, busy, stoppable],
  );

  // A tab that went while this chat stayed on screen was closed by the person. Before the
  // effect below, which would otherwise add it straight back.
  const seen = useRef<{ id: string; present: boolean } | null>(null);
  useEffect(() => {
    if (seen.current?.id === id && seen.current.present && !present && view)
      closed.set(conversationId, view.spell);
    seen.current = { id, present };
  }, [id, present, view, conversationId]);

  useEffect(() => {
    if (!appUse || !view || isMobile) return;
    if (pendingOpen === conversationId && appViewOpenRequests.take(conversationId)) {
      opened.set(conversationId, view.spell);
      closed.delete(conversationId);
      panel.open(request);
      return;
    }
    if (!view.live || present) return;
    // A spell spent in the floating window has had its view: hiding the window later must not
    // pop it open in the chat.
    if (view.placement !== "panel") {
      opened.set(conversationId, Math.max(opened.get(conversationId) ?? 0, view.spell));
      return;
    }
    if ((opened.get(conversationId) ?? 0) < view.spell) {
      opened.set(conversationId, view.spell);
      panel.open(request);
    } else if (closed.get(conversationId) !== view.spell) {
      // Back during a spell whose tab went with the page: listed, not selected.
      panel.append(request);
    }
  }, [appUse, view, isMobile, conversationId, panel, request, present, pendingOpen]);

  useEffect(() => {
    if (present) panel.refresh(request);
  }, [panel, request, present]);

  useEffect(() => () => panel.release(id), [panel, id]);
  return null;
}

/**
 * Mounted once in the layout: the floating window's way back into a chat, which may be any
 * chat, so it navigates there and leaves the opening to that chat's owner. It asks main which
 * chat when told to and once on mount, for a page that was still loading when the ask came.
 */
export function AppViewReturns() {
  const appUse = useDesktopAppUse();
  const navigate = useNavigate();
  useEffect(() => {
    if (!appUse) return;
    const take = () =>
      void appUse.takeOpenChat().then(
        (conversationId) => {
          if (!conversationId) return;
          appViewOpenRequests.request(conversationId);
          void navigate({ to: "/chat/$conversationId", params: { conversationId } });
        },
        () => {},
      );
    take();
    return appUse.onOpenChat(take);
  }, [appUse, navigate]);
  return null;
}
