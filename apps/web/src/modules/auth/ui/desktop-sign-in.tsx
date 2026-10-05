import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { DesktopAuth } from "@chat/desktop-rpc";
import { redeemDesktopTicket } from "~/modules/auth/client.ts";
import {
  challengeOf,
  createVerifier,
  isTicketShaped,
  normaliseTicket,
} from "~/modules/auth/desktop-ticket.ts";
import { identityNavigation } from "~/modules/auth/identity-context.ts";
import { desktopSignInPath } from "~/modules/auth/ui/desktop-sign-in-path.ts";
import { Card, CardContent, CardHeader, CardTitle } from "~/ui/card.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button, buttonVariants } from "~/ui/primitives/button";
import { Field, FieldError, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { cn } from "~/ui/utils";
import { AuthScreen } from "./auth-screen.tsx";

/**
 * Session storage rather than state: the verifier must survive a reload of
 * the login page while the browser tab that carries its challenge is open,
 * and must not survive the window, or a stale one would refuse a fresh code.
 */
const VERIFIER_KEY = "chat.desktop-verifier";

function loadVerifier(): string {
  const stored = sessionStorage.getItem(VERIFIER_KEY);
  if (stored) return stored;
  const fresh = createVerifier();
  sessionStorage.setItem(VERIFIER_KEY, fresh);
  return fresh;
}

/**
 * The shell's login screen. There is no password form here: sign-in happens
 * in the system browser, which mints a code the shell redeems. The code
 * arrives either through the deep link (`auth.onTicket`) or by paste.
 *
 * A deep-linked code only fills the field; the person presses Continue. Any
 * page can open `chat-desktop://sign-in?ticket=…`, and a code minted from
 * Settings › Devices carries no challenge, so the verifier cannot tell a code
 * this shell asked for from one an attacker's account minted. Redeeming it
 * unasked would sign this computer into that account.
 */
export function DesktopSignIn({ auth }: { auth: DesktopAuth }) {
  const queryClient = useQueryClient();
  const [verifier] = useState(loadVerifier);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [shapeError, setShapeError] = useState<string | null>(null);
  const continueButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    void challengeOf(verifier).then((value) => {
      if (!cancelled) setChallenge(value);
    });
    return () => {
      cancelled = true;
    };
  }, [verifier]);

  const redeem = useMutation({
    mutationFn: (ticket: string) => redeemDesktopTicket({ ticket, verifier }),
    onSuccess: () => {
      sessionStorage.removeItem(VERIFIER_KEY);
      // What IdentityBoundary does on an identity change: nothing cached
      // before sign-in may greet the account that just arrived.
      queryClient.clear();
      identityNavigation.replace("/");
    },
  });

  const { mutate } = redeem;
  const submit = useCallback(
    (raw: string) => {
      const ticket = normaliseTicket(raw);
      if (!isTicketShaped(ticket)) {
        setShapeError("Enter the whole code from your browser.");
        return;
      }
      setShapeError(null);
      mutate(ticket);
    },
    [mutate],
  );

  useEffect(
    () =>
      auth.onTicket((ticket) => {
        setCode(ticket);
        setShapeError(null);
        continueButton.current?.focus();
      }),
    [auth],
  );

  const changeServer = useMutation({
    mutationFn: () => auth.changeServer(),
    onError: (cause) => toast.error(cause.message),
  });
  const error = shapeError ?? (redeem.isError ? redeem.error.message : null);
  const browserHref =
    challenge === null ? null : `${window.location.origin}${desktopSignInPath(challenge)}`;

  return (
    <AuthScreen>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">
            Sign in in your browser, then paste the code it shows you here.
          </p>
          {browserHref ? (
            <a
              href={browserHref}
              target="_blank"
              rel="noopener"
              className={cn(buttonVariants({ variant: "default" }), "w-full")}
            >
              Sign in in your browser
            </a>
          ) : null}
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit(code);
            }}
          >
            <Field>
              <FieldLabel htmlFor="desktop-code">Code</FieldLabel>
              <Input
                id="desktop-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                disabled={redeem.isPending}
              />
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <PendingButton
              ref={continueButton}
              type="submit"
              className="w-full"
              pending={redeem.isPending}
            >
              Continue
            </PendingButton>
          </form>
          {auth.canChangeServer ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="self-center"
              disabled={changeServer.isPending}
              onClick={() => changeServer.mutate()}
            >
              Not your server? Change server
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </AuthScreen>
  );
}
