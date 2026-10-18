import { createFileRoute } from "@tanstack/react-router";
import { signInRedirect } from "~/modules/mcp-server/server/sign-in-redirect.ts";

export const Route = createFileRoute("/oauth/sign-in")({
  server: {
    handlers: {
      GET: ({ request }) => signInRedirect(request),
    },
  },
});
