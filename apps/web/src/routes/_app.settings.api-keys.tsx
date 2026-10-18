import { createFileRoute } from "@tanstack/react-router";
import { apiKeysQuery } from "~/modules/api-keys/client/queries.ts";
import { ApiKeysPage } from "~/modules/settings/ui/api-keys-page.tsx";

export const Route = createFileRoute("/_app/settings/api-keys")({
  loader: ({ context }) => context.queryClient.ensureQueryData(apiKeysQuery),
  component: ApiKeysPage,
});
