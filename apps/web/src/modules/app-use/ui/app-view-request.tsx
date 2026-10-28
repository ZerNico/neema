import { CursorInWindowIcon } from "@hugeicons/core-free-icons";
import type { DetailPanelRequest } from "~/ui/detail-panel.tsx";
import { m } from "~/paraglide/messages.js";
import { AppViewBar, AppViewStage } from "./app-view.tsx";

/**
 * Panel tab ids of a chat's live view of app use. Plain values live here, apart from the
 * components, so Fast Refresh can swap those.
 */
export const APP_VIEW_PREFIX = "apps:";

/**
 * A chat's live view of its app use as a panel tab, named after the app. Never restored: there
 * is nothing to show until the chat uses an app again.
 */
export function appViewRequest(input: {
  conversationId: string;
  app: string;
  busy: boolean;
  /** Ends the answer, as the composer's Stop does; absent when none runs here. */
  stop: (() => void) | undefined;
}): DetailPanelRequest {
  return {
    id: `${APP_VIEW_PREFIX}${input.conversationId}`,
    title: input.app || m.app_view_tab(),
    icon: CursorInWindowIcon,
    busy: input.busy,
    fill: true,
    actions: <AppViewBar conversationId={input.conversationId} stop={input.stop} />,
    body: <AppViewStage conversationId={input.conversationId} />,
  };
}
