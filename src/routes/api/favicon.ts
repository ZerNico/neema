import { createFileRoute } from "@tanstack/react-router";
import { sessionFromHeaders } from "~/modules/auth/server/auth.ts";

// Favicon proxy: the browser talks only to our origin; the upstream lookup
// happens server-side. Without this every source chip would reveal the visited
// host to a third party from each user's browser (IP, cookies, referer).
// The server still asks Google's s2 service — one aggregate egress point.
const UPSTREAM = (domain: string) =>
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;

// Registrable hostnames only — this is an outbound fetch keyed by a
// client-supplied string, so the accepted shape is deliberately narrow.
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/i;

const FETCH_TIMEOUT_MS = 5_000;

export const Route = createFileRoute("/api/favicon")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const current = await sessionFromHeaders(request.headers);
        // An account still waiting on approval is declined here as though
        // signed out: only a server function can say why, and the browser
        // is already being sent to the waiting screen by the app route.
        if (!current?.approved) return new Response("Unauthorized", { status: 401 });

        const domain = new URL(request.url).searchParams.get("domain") ?? "";
        if (!HOSTNAME.test(domain)) return new Response("Bad domain", { status: 400 });

        let upstream: Response;
        try {
          upstream = await fetch(UPSTREAM(domain.toLowerCase()), {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
        } catch {
          return new Response("Upstream unavailable", { status: 404 });
        }
        const contentType = upstream.headers.get("content-type") ?? "";
        if (!upstream.ok || !contentType.startsWith("image/")) {
          return new Response("Not found", { status: 404 });
        }

        return new Response(upstream.body, {
          headers: {
            "Content-Type": contentType,
            // Icons change rarely; a day of shared caching keeps repeat
            // renders (and the upstream) quiet.
            "Cache-Control": "public, max-age=86400",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    },
  },
});
