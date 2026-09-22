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

export const DESKTOP_SIGN_IN_SCHEME_URL = "chat-desktop://sign-in";

/** The browser page the shell opens; the challenge rides along when there is one. */
export const desktopSignInPath = (challenge?: string) =>
  challenge ? `/desktop/sign-in?challenge=${encodeURIComponent(challenge)}` : "/desktop/sign-in";

/**
 * The browser half of desktop sign-in. The person is already signed in here
 * with their real cookies; one click mints a code for the desktop. The deep
 * link is offered, never fired: macOS has no scheme registered until the app
 * is packaged, and a silent failure would leave the reader with nothing.
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
  });
  const ticket = mint.data;

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to neema Desktop</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {ticket ? (
            <>
              <a
                href={`${DESKTOP_SIGN_IN_SCHEME_URL}?ticket=${ticket.ticket}`}
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
              <PendingButton className="w-full" pending={mint.isPending} onClick={() => mint.mutate()}>
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
    </div>
  );
}
