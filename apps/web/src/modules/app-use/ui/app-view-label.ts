import type { AppUseUpdate } from "@chat/desktop-rpc";
import { m } from "~/paraglide/messages.js";
import { isAppTool } from "../tool-schema.ts";
import { APP_ACTIVITY } from "./app-activity.ts";

/** What the view says it is doing: the call running, else where the chat stands. */
export function appViewLabel(view: AppUseUpdate) {
  if (view.paused) return m.app_view_paused();
  if (view.call && isAppTool(view.call.name))
    return APP_ACTIVITY[view.call.name].running(view.call.args);
  const app = view.app || m.app_view_tab();
  return view.live ? m.app_view_title({ app }) : m.app_view_done();
}
