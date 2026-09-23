import { createFileRoute, redirect } from "@tanstack/react-router";
import { useApprovalStatus } from "~/modules/auth/use-approval-status.ts";
import { useEffect } from "react";
import { approvalStatusQuery, authClient } from "~/modules/auth/client.ts";
import { Button } from "~/ui/primitives/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "~/ui/card.tsx";
import { AuthScreen } from "~/modules/auth/ui/auth-screen.tsx";

export const Route = createFileRoute("/pending")({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(approvalStatusQuery);
    if (status === null) throw redirect({ to: "/login" });
    if (status === "approved") throw redirect({ to: "/" });
  },
  component: PendingPage,
});

function PendingPage() {
  const { data: status } = useApprovalStatus();

  useEffect(() => {
    if (status === "approved") window.location.replace("/");
    else if (status === null) window.location.replace("/login");
  }, [status]);

  const rejected = status === "rejected";

  return (
    <AuthScreen>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{rejected ? "Account declined" : "Waiting for approval"}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {rejected
              ? "An admin declined this account. Ask whoever runs this instance if you think that’s a mistake."
              : "Your account is set up. An admin of this instance has to let it in before you can start a chat."}
          </p>
        </CardContent>
        <CardFooter>
          <Button
            variant="outline"
            className="w-full"
            onClick={async () => {
              await authClient.signOut();
              // Replace the document rather than navigate, the same thing
              // IdentityBoundary does inside the app: a cached "pending" from
              // this account must not greet whoever signs in next.
              window.location.assign("/login");
            }}
          >
            Sign out
          </Button>
        </CardFooter>
      </Card>
    </AuthScreen>
  );
}
