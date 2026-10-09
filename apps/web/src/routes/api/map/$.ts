import { createFileRoute } from "@tanstack/react-router";
import { Effect, Option } from "effect";
import { proxyMap } from "~/modules/genui/server/map-proxy.ts";
import { MAPS_TOOL, readMaps } from "~/modules/genui/settings.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import { approvedSession, unauthorized } from "~/server/approved-route.ts";
import { publicUrl } from "~/server/public-url.ts";
import { runtime } from "~/server/runtime.ts";

/**
 * Map styles and tiles for ui block maps, fetched by the server so the reader's
 * browser never contacts the tile provider. Signed-in readers only, and only
 * while an admin has maps on.
 */
export const Route = createFileRoute("/api/map/$")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await approvedSession(request);
        if (!session) return unauthorized();
        const settings = await runtime.runPromise(
          Effect.gen(function* () {
            const tools = yield* Effect.serviceOption(ToolsRepo);
            return readMaps(Option.isSome(tools) ? yield* tools.value.getTool(MAPS_TOOL) : null);
          }),
        );
        if (!settings.enabled) return new Response("Not found", { status: 404 });
        const url = new URL(request.url);
        return proxyMap(params._splat ?? "", url, settings.services, publicUrl() ?? url.origin);
      },
    },
  },
});
