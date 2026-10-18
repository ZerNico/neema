import { Alert02Icon, CheckmarkBadge01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { authClient } from "~/modules/auth/client.ts";
import { AuthScreen } from "~/modules/auth/ui/auth-screen.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/ui/card.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { FieldError } from "~/ui/primitives/field";
import type { getConsentRequest } from "../server/functions.ts";
import { OFFLINE_ACCESS, type McpScope } from "../scopes.ts";
import { ScopePicker } from "./scope-picker.tsx";

export type ConsentRequest = Awaited<ReturnType<typeof getConsentRequest>>;

const REFUSALS = {
  impersonating: {
    title: "You’re acting as someone else",
    body: "Stop acting as them before connecting an app to their account.",
  },
  "not-allowed": {
    title: "Can’t connect apps",
    body: "Your account isn’t allowed to connect apps. Ask an admin of this instance.",
  },
  invalid: {
    title: "This request has expired",
    body: "Go back to the app and connect again.",
  },
} as const;

/** The provider answers a fetch with where the browser goes next. */
const decide = async (body: { accept: boolean; scope?: string; oauth_query: string }) => {
  const { data, error } = await authClient.$fetch<{ url: string }>("/oauth2/consent", {
    method: "POST",
    body,
  });
  if (error || !data?.url) throw new Error(error?.message ?? "Could not finish connecting.");
  window.location.assign(data.url);
};

export function ConsentPage({
  query,
  account,
  request,
}: {
  query: string;
  account: string;
  request: ConsentRequest;
}) {
  if (request.state !== "ready") {
    const refusal = REFUSALS[request.state];
    return (
      <AuthScreen>
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>{refusal.title}</CardTitle>
            <CardDescription>{refusal.body}</CardDescription>
          </CardHeader>
        </Card>
      </AuthScreen>
    );
  }
  return <ConsentForm query={query} account={account} request={request} />;
}

function ConsentForm({
  query,
  account,
  request,
}: {
  query: string;
  account: string;
  request: Extract<ConsentRequest, { state: "ready" }>;
}) {
  const { client, redirectHost, scopes, offline } = request;
  const [picked, setPicked] = useState<ReadonlyArray<McpScope>>(scopes);
  const allow = useMutation({
    mutationFn: () =>
      decide({
        accept: true,
        scope: [...picked, ...(offline ? [OFFLINE_ACCESS] : [])].join(" "),
        oauth_query: query,
      }),
  });
  const deny = useMutation({ mutationFn: () => decide({ accept: false, oauth_query: query }) });
  const error = allow.error ?? deny.error;
  const busy = allow.isPending || deny.isPending || allow.isSuccess || deny.isSuccess;

  return (
    <AuthScreen>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Connect {client.name}</CardTitle>
          <CardDescription>It will act as {account}.</CardDescription>
          {client.verifiedHost ? (
            <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
              <HugeiconsIcon icon={CheckmarkBadge01Icon} strokeWidth={2} className="size-4" />
              Registered by {client.verifiedHost}
            </p>
          ) : (
            <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
              <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-4" />
              The app named itself. Only connect apps you started.
            </p>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <ScopePicker idPrefix="consent" scopes={scopes} picked={picked} onChange={setPicked} />
          <p className="text-muted-foreground text-xs">
            {redirectHost ? `Returns to ${redirectHost}. ` : ""}
            {offline ? "Stays connected until you remove it in Settings." : ""}
          </p>
          {error ? <FieldError>{error.message}</FieldError> : null}
        </CardContent>
        <CardFooter className="flex justify-end gap-2">
          <PendingButton
            variant="outline"
            pending={deny.isPending}
            disabled={busy}
            onClick={() => deny.mutate()}
          >
            Cancel
          </PendingButton>
          <PendingButton
            pending={allow.isPending}
            disabled={busy || picked.length === 0}
            onClick={() => allow.mutate()}
          >
            Allow
          </PendingButton>
        </CardFooter>
      </Card>
    </AuthScreen>
  );
}
