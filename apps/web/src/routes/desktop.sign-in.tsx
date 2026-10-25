import { createFileRoute, redirect } from "@tanstack/react-router";
import { meQuery } from "~/modules/auth/client.ts";
import { DesktopSignInPage } from "~/modules/auth/ui/desktop-sign-in-page.tsx";
import { desktopSignInPath } from "~/modules/auth/ui/desktop-sign-in-path.ts";
import { useDesktop } from "~/modules/desktop/client/bridge.ts";
import { useSync } from "~/modules/sync/client/use-sync.ts";
import { Card, CardContent, CardHeader, CardTitle } from "~/ui/card.tsx";
import { AuthScreen } from "~/modules/auth/ui/auth-screen.tsx";
import { m } from "~/paraglide/messages.js";

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
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me)
      throw redirect({ to: "/login", search: { redirect: desktopSignInPath(search.challenge) } });
    if (me.approval !== "approved") throw redirect({ to: "/pending" });
    return { user: me.user };
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
            <CardTitle>{m.app_desktop_sign_in_title()}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">{m.app_desktop_sign_in_in_browser()}</p>
          </CardContent>
        </Card>
      </AuthScreen>
    );
  return <DesktopSignInPage user={user} challenge={challenge} />;
}
