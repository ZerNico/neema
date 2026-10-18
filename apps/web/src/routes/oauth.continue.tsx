import { createFileRoute, redirect } from "@tanstack/react-router";
import { approvalStatusQuery, authClient, sessionUserQuery } from "~/modules/auth/client.ts";
import { AuthScreen } from "~/modules/auth/ui/auth-screen.tsx";
import { AUTHORIZE_PATH, unpackQuery } from "~/modules/mcp-server/authorize-query.ts";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "~/ui/card.tsx";
import { Button } from "~/ui/primitives/button";

/**
 * Sends a person through `/login` and back, then asks the authorization
 * server again with a session. Every way of signing in, social and OIDC
 * included, already returns to a `redirect` path, which is why this is one.
 * An app that asked for a newer sign-in finds someone signed in here, and the
 * person chooses to sign in again: a link alone never signs anyone out.
 */
export const Route = createFileRoute("/oauth/continue")({
  validateSearch: (search: Record<string, unknown>): { request?: string; fresh?: true } => ({
    ...(typeof search["request"] === "string" ? { request: search["request"] } : {}),
    ...(search["fresh"] === 1 || search["fresh"] === "1" ? { fresh: true as const } : {}),
  }),
  beforeLoad: async ({ context, search }) => {
    const query = unpackQuery(search.request);
    if (query === null) throw redirect({ to: "/" });
    const back = `/oauth/continue?request=${search.request}`;
    const user = await context.queryClient.ensureQueryData(sessionUserQuery);
    if (!user) throw redirect({ to: "/login", search: { redirect: back } });
    if (search.fresh) return { back };
    const approval = await context.queryClient.ensureQueryData(approvalStatusQuery);
    if (approval !== "approved") throw redirect({ to: "/pending" });
    throw redirect({ href: `${AUTHORIZE_PATH}?${query}`, reloadDocument: true });
  },
  component: SignInAgain,
});

function SignInAgain() {
  const { back } = Route.useRouteContext();
  return (
    <AuthScreen>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in again</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            The app you’re connecting asks for a fresh sign-in before it gets access.
          </p>
        </CardContent>
        <CardFooter className="flex flex-col gap-2">
          <Button
            className="w-full"
            onClick={async () => {
              await authClient.signOut();
              // A new document, as the pending page does: nothing cached for this account stays.
              window.location.assign(`/login?redirect=${encodeURIComponent(back)}`);
            }}
          >
            Sign in again
          </Button>
          <Button variant="ghost" className="w-full" onClick={() => window.location.assign("/")}>
            Cancel
          </Button>
        </CardFooter>
      </Card>
    </AuthScreen>
  );
}
