import { createFileRoute, redirect } from "@tanstack/react-router";
import { sharedPrefill } from "~/modules/chat/shared-prefill.ts";

/**
 * Where the installed app's share target lands (`site.webmanifest`): what was
 * shared becomes a new chat's draft, never a sent message, so the person reads
 * it before anything reaches a model.
 */
export const Route = createFileRoute("/_app/share")({
  validateSearch: (search: Record<string, unknown>) => ({
    title: typeof search["title"] === "string" ? search["title"] : undefined,
    text: typeof search["text"] === "string" ? search["text"] : undefined,
    url: typeof search["url"] === "string" ? search["url"] : undefined,
  }),
  beforeLoad: ({ search }) => {
    const prefill = sharedPrefill(search);
    throw redirect({
      to: "/",
      search: {},
      replace: true,
      ...(prefill ? { state: { chatPrefill: prefill } } : {}),
    });
  },
});
