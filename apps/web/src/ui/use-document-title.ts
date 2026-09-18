import { useEffect } from "react";

const BASE_TITLE = "Chat";

/**
 * Sets the browser tab title for as long as the component is mounted, then
 * restores the app default. Imperative rather than route `head` metadata
 * because the title arrives asynchronously (generated after the first
 * message) and reaches us through the query cache, not through loader data.
 */
export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    const trimmed = title?.trim();
    if (!trimmed) return;
    document.title = `${trimmed} · ${BASE_TITLE}`;
    return () => {
      document.title = BASE_TITLE;
    };
  }, [title]);
}
