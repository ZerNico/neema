import { createFileRoute, redirect } from "@tanstack/react-router";
import { approvalStatusQuery, sessionUserQuery } from "~/modules/auth/client.ts";
import { desktopSignInPath, DesktopSignInPage } from "~/modules/auth/ui/desktop-sign-in-page.tsx";
import { useDesktop } from "~/modules/desktop/client/bridge.ts";
import { useSync } from "~/modules/sync/client/use-sync.ts";
import { Card, CardContent, CardHeader, CardTitle } from "~/ui/card.tsx";
import { AuthScreen } from "~/modules/auth/ui/auth-screen.tsx";

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Outside `_app` on purpose: this page has no sidebar and must not load the
 * conversation list for a tab that closes in a minute.
 */
export const Route = createFileRoute("/desktop/sign-in")({
  validateSearch: (search: Record<string, unknown>): { challenge?: string } =>
    typeof search["challenge"] === "string" && CHALLENGE_PATTERN.test(search["challenge"])
      ? { challenge: search["challenge"] }
      : {},
  beforeLoad: async ({ context, search }) => {
    const user = await context.queryClient.ensureQueryData(sessionUserQuery);
    if (!user)
      throw redirect({ to: "/login", search: { redirect: desktopSignInPath(search.challenge) } });
    const approval = await context.queryClient.ensureQueryData(approvalStatusQuery);
    if (approval !== "approved") throw redirect({ to: "/pending" });
    return { user };
  },
  loader: ({ context }) => ({ user: context.user }),
  component: DesktopSignInRoute,
});

function DesktopSignInRoute() {
  const { user } = Route.useLoaderData();
  const { challenge } = Route.useSearch();
  // No `_app` shell here, so the feed that tells the code it was redeemed
  // has to be opened by this page itself.
  useSync();
  const inShell = useDesktop() !== null;
  if (inShell)
    return (
      <AuthScreen>
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Sign in to neema Desktop</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">Open this page in your browser.</p>
          </CardContent>
        </Card>
      </AuthScreen>
    );
  return <DesktopSignInPage user={user} challenge={challenge} />;
}
