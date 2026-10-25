import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { DesktopAuth } from "@chat/desktop-rpc";
import { redeemDesktopTicket } from "~/modules/auth/client.ts";
import {
  challengeOf,
  createVerifier,
  formatTicket,
  isTicketShaped,
  normaliseTicket,
  UNBOUND_TICKET,
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
import { m } from "~/paraglide/messages.js";

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
 * A deep-linked code signs in at once only if it is bound to this shell's
 * challenge. Any page can open `chat-desktop://sign-in?ticket=…`, and a code
 * minted from Settings › Devices carries no challenge, so it could be one an
 * attacker's account minted; redeeming that unasked would sign this computer
 * into their account. The server leaves such a code unused, and it waits in
 * the field for Continue.
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
    mutationFn: ({ ticket, boundOnly }: { ticket: string; boundOnly?: boolean }) =>
      redeemDesktopTicket({ ticket, verifier, ...(boundOnly ? { boundOnly } : {}) }),
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
        setShapeError(m.auth_desktop_enter_code());
        return;
      }
      setShapeError(null);
      mutate({ ticket });
    },
    [mutate],
  );

  useEffect(
    () =>
      auth.onTicket((ticket) => {
        setCode(formatTicket(normaliseTicket(ticket)));
        setShapeError(null);
        mutate({ ticket: normaliseTicket(ticket), boundOnly: true });
      }),
    [auth, mutate],
  );

  const changeServer = useMutation({
    mutationFn: () => auth.changeServer(),
    onError: (cause) => toast.error(cause.message),
  });
  // A code this shell did not ask for is not wrong, only unconfirmed: it
  // waits for Continue, focused once the button is enabled again.
  const unconfirmed = redeem.isError && redeem.error.message === UNBOUND_TICKET;
  useEffect(() => {
    if (unconfirmed) continueButton.current?.focus();
  }, [unconfirmed]);
  const error = shapeError ?? (redeem.isError && !unconfirmed ? redeem.error.message : null);
  const browserHref =
    challenge === null ? null : `${window.location.origin}${desktopSignInPath(challenge)}`;

  return (
    <AuthScreen>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{m.auth_desktop_title()}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">{m.auth_desktop_intro()}</p>
          {browserHref ? (
            <a
              href={browserHref}
              target="_blank"
              rel="noopener"
              className={cn(buttonVariants({ variant: "default" }), "w-full")}
            >
              {m.auth_desktop_browser()}
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
              <FieldLabel htmlFor="desktop-code">{m.auth_desktop_code()}</FieldLabel>
              <Input
                id="desktop-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                // oxlint-disable-next-line i18n/no-literal-text -- the code's shape, not words
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
              {m.auth_desktop_continue()}
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
              {m.auth_desktop_change_server()}
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </AuthScreen>
  );
}
