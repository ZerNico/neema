import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { authClient, createDesktopTicket } from "~/modules/auth/client.ts";
import { TicketCode } from "~/modules/auth/ui/ticket-code.tsx";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "~/ui/card.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "~/ui/primitives/avatar";
import { Button, buttonVariants } from "~/ui/primitives/button";
import { FieldError } from "~/ui/primitives/field";
import { cn } from "~/ui/utils";
import { AuthScreen } from "./auth-screen.tsx";
import { desktopSignInPath } from "./desktop-sign-in-path.ts";

const deepLink = (ticket: string) => `chat-desktop://sign-in?ticket=${encodeURIComponent(ticket)}`;

/**
 * The browser half of desktop sign-in. The person is already signed in here
 * with their real cookies; one click mints a code for the desktop. When the
 * app sent them here (a challenge came with it), it is waiting, so the link
 * opens it at once; the button and the code stay for a browser that refused.
 */
export function DesktopSignInPage({
  user,
  challenge,
}: {
  user: { name: string; email: string; image?: string | null | undefined };
  challenge?: string | undefined;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [signingOut, setSigningOut] = useState(false);
  const mint = useMutation({
    mutationFn: () => createDesktopTicket(challenge ? { challenge } : {}),
    onSuccess: (minted) => {
      if (challenge) window.location.assign(deepLink(minted.ticket));
    },
  });
  const ticket = mint.data;

  return (
    <AuthScreen>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to neema Desktop</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {ticket ? (
            <>
              <a
                href={deepLink(ticket.ticket)}
                className={cn(buttonVariants({ variant: "default" }), "w-full")}
              >
                Open neema Desktop
              </a>
              <p className="text-muted-foreground text-sm">
                If the app doesn’t open, paste this code into it.
              </p>
              <TicketCode
                ticket={ticket.ticket}
                ticketId={ticket.ticketId}
                expiresAt={ticket.expiresAt}
                renewing={mint.isPending}
                onRenew={() => mint.mutate()}
              />
              <p className="text-muted-foreground text-sm">You can close this tab afterwards.</p>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <Avatar className="size-10">
                  {user.image ? <AvatarImage src={user.image} alt="" /> : null}
                  <AvatarFallback>{user.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium">{user.name}</span>
                  <span className="text-muted-foreground truncate text-xs">{user.email}</span>
                </div>
              </div>
              {mint.isError ? <FieldError>{mint.error.message}</FieldError> : null}
              <PendingButton
                className="w-full"
                pending={mint.isPending}
                onClick={() => mint.mutate()}
              >
                Continue as {user.name}
              </PendingButton>
            </>
          )}
        </CardContent>
        {ticket ? null : (
          <CardFooter>
            <Button
              variant="link"
              // oxlint-disable-next-line shadcn/no-restyle -- the link variant has to sit inline with the sentence around it
              className="h-auto p-0"
              disabled={signingOut}
              onClick={async () => {
                setSigningOut(true);
                await authClient.signOut();
                // The cache still holds this account; the next one must not see it.
                queryClient.clear();
                await navigate({
                  to: "/login",
                  search: { redirect: desktopSignInPath(challenge) },
                });
              }}
            >
              Use a different account
            </Button>
          </CardFooter>
        )}
      </Card>
    </AuthScreen>
  );
}
