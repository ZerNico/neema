import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { approvalStatusQuery, authClient } from "~/modules/auth/client.ts";
import { Button } from "~/ui/primitives/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "~/ui/card.tsx";

export const Route = createFileRoute("/pending")({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(approvalStatusQuery);
    if (status === null) throw redirect({ to: "/login" });
    if (status === "approved") throw redirect({ to: "/" });
  },
  component: PendingPage,
});

function PendingPage() {
  const navigate = useNavigate();
  // An approval happens in another person's browser, so this screen has to ask
  // rather than be told. A minute is fast enough for someone who is waiting.
  const { data: status } = useQuery({ ...approvalStatusQuery, refetchInterval: 60_000 });

  useEffect(() => {
    if (status === "approved") void navigate({ to: "/" });
  }, [status, navigate]);

  const rejected = status === "rejected";

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
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
    </div>
  );
}
