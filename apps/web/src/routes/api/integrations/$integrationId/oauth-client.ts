import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { findIntegrationType } from "~/modules/integrations/catalog.ts";
import { publicUrl } from "~/server/public-url.ts";
import { callbackPath } from "~/modules/integrations/server/oauth.ts";
import { IntegrationRepo } from "~/modules/integrations/server/repo.ts";
import { runtime } from "~/server/runtime.ts";

/**
 * This app as an OAuth client, for authorization servers that read a client
 * metadata document instead of registering clients: its address is the
 * client id. Public by design; it names only the app and where sign-ins return.
 */
export const Route = createFileRoute("/api/integrations/$integrationId/oauth-client")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        // The client id is this exact address, so only the declared one can serve it.
        const origin = publicUrl();
        const row = await runtime.runPromise(
          Effect.flatMap(IntegrationRepo, (repo) => repo.getConfig(params.integrationId)),
        );
        const type = row ? findIntegrationType(row.kind) : null;
        if (!row || !origin?.startsWith("https://") || type?.toolSource !== "catalog")
          return new Response("Not found", { status: 404 });
        const clientId = `${origin}/api/integrations/${row.id}/oauth-client`;
        return Response.json(
          {
            client_id: clientId,
            client_name: `neema · ${row.name}`,
            client_uri: origin,
            redirect_uris: [`${origin}${callbackPath(row.id)}`],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
            application_type: "web",
          },
          { headers: { "cache-control": "public, max-age=300" } },
        );
      },
    },
  },
});
