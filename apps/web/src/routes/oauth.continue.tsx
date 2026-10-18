import { createFileRoute, redirect } from "@tanstack/react-router";
import { approvalStatusQuery, sessionUserQuery } from "~/modules/auth/client.ts";
import { AUTHORIZE_PATH, unpackQuery } from "~/modules/mcp-server/authorize-query.ts";

/**
 * Sends a person through `/login` and back, then asks the authorization
 * server again with a session. Every way of signing in, social and OIDC
 * included, already returns to a `redirect` path, which is why this is one.
 */
export const Route = createFileRoute("/oauth/continue")({
  validateSearch: (search: Record<string, unknown>): { request?: string } =>
    typeof search["request"] === "string" ? { request: search["request"] } : {},
  beforeLoad: async ({ context, search }) => {
    const query = unpackQuery(search.request);
    if (query === null) throw redirect({ to: "/" });
    const user = await context.queryClient.ensureQueryData(sessionUserQuery);
    if (!user) {
      throw redirect({
        to: "/login",
        search: { redirect: `/oauth/continue?request=${search.request}` },
      });
    }
    const approval = await context.queryClient.ensureQueryData(approvalStatusQuery);
    if (approval !== "approved") throw redirect({ to: "/pending" });
    throw redirect({ href: `${AUTHORIZE_PATH}?${query}`, reloadDocument: true });
  },
});
