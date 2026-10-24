import { createFileRoute, redirect } from "@tanstack/react-router";
import { meQuery } from "~/modules/auth/client.ts";
import { authorizeQuery, packQuery, unpackQuery } from "~/modules/mcp-server/authorize-query.ts";
import { getConsentRequest } from "~/modules/mcp-server/server/functions.ts";
import { ConsentPage } from "~/modules/mcp-server/ui/consent-page.tsx";

/** The consent decision, over the exact query the authorization server signed. */
export const Route = createFileRoute("/oauth/approve")({
  validateSearch: (search: Record<string, unknown>): { request?: string } =>
    typeof search["request"] === "string" ? { request: search["request"] } : {},
  beforeLoad: async ({ context, search }) => {
    const query = unpackQuery(search.request);
    if (query === null) throw redirect({ to: "/" });
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me) {
      throw redirect({
        to: "/oauth/continue",
        search: { request: packQuery(authorizeQuery(query)) },
      });
    }
    if (me.approval !== "approved") throw redirect({ to: "/pending" });
    return { query, account: me.user.email };
  },
  loader: async ({ context }) => ({
    query: context.query,
    account: context.account,
    request: await getConsentRequest({ data: { query: context.query } }),
  }),
  component: function Approve() {
    const { query, account, request } = Route.useLoaderData();
    return <ConsentPage query={query} account={account} request={request} />;
  },
});
