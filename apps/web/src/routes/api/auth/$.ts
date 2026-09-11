import { createFileRoute } from "@tanstack/react-router";
import { currentAuth } from "~/modules/auth/server/auth.ts";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }) => (await currentAuth()).handler(request),
      POST: async ({ request }) => (await currentAuth()).handler(request),
    },
  },
});
