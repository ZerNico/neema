import type { MenuItemConstructorOptions } from "electron";
import { m } from "../paraglide/messages.js";
import { chatKey } from "./chat-key.ts";
import type { LiveView } from "./live.ts";

/**
 * App use in neema's menu bar item, as Codex keeps a status item while it uses the Mac: the
 * apps in use beside the icon, and at the top of its menu each chat's line with Pause or
 * Resume. It is there however neema's window is, which the chat's panel tab is not.
 * `signature` changes only when what is shown does, since pictures arrive a few times a second.
 */
export function appUseStatus(live: LiveView, origin: string | null) {
  if (!origin) return { title: "", items: [], signature: "" };
  const chats = live.using(origin);
  const options = { locale: live.locale(origin) };
  const apps = new Set(chats.filter((chat) => chat.live && chat.app).map((chat) => chat.app));
  const items: MenuItemConstructorOptions[] = chats.flatMap((chat) => [
    // A paused chat's line says only that it is paused; the app tells it from another.
    {
      label: chat.label,
      ...(chat.paused && chat.app ? { sublabel: chat.app } : {}),
      enabled: false,
    },
    {
      label: chat.paused ? m.app_view_resume({}, options) : m.app_view_pause({}, options),
      click: () => live.pause(chatKey(origin, chat.conversationId), !chat.paused),
    },
    { type: "separator" },
  ]);
  const signature = JSON.stringify([
    origin,
    options.locale,
    chats.map((chat) => [chat.conversationId, chat.label, chat.app, chat.paused, chat.live]),
  ]);
  return { title: [...apps].join(", "), items, signature };
}
