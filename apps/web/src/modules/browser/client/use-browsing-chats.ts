import { useMemo } from "react";
import { useBrowserTabs } from "./browser-store.ts";

/** Chats whose answer is acting through one of their browser tabs right now. */
export function useBrowsingChats(): ReadonlySet<string> {
  const tabs = useBrowserTabs();
  const key = [...tabs.values()]
    .filter((tab) => tab.usedBy !== null)
    .map((tab) => tab.owner)
    .toSorted()
    .join("\n");
  return useMemo(() => new Set(key ? key.split("\n") : []), [key]);
}
