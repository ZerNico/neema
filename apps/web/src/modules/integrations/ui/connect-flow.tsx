import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { sessionUserQuery } from "~/modules/auth/client.ts";
import { useDesktop } from "~/modules/desktop/client/bridge.ts";
import { Button } from "~/ui/primitives/button";
import { DialogFooter } from "~/ui/primitives/dialog";
import { FieldError } from "~/ui/primitives/field";
import { Spinner } from "~/ui/primitives/spinner";
import { findIntegrationType } from "../catalog.ts";
import { connectUrl, myIntegrationsQuery } from "../client/queries.ts";
import { onSignIn, signInLanding } from "../client/sign-in-channel.ts";
import type { UserIntegration } from "../schema.ts";
import { ApiKeyDialog, TurnOnButton } from "./connect-actions.tsx";
import { integrationEntry } from "./directory-entries.ts";
import { DirectoryEntryHeader } from "./integration-directory.tsx";

type Step =
  | { kind: "start" }
  | { kind: "waiting"; attempt: string; url: string; blocked: boolean }
  | { kind: "failed"; error: string };

/**
 * Connecting one integration without leaving the dialog: sign in in a window
 * of its own, paste a key, or turn it on. Whichever way, it is done once a
 * new account of this person's shows up, which also covers the desktop app,
 * whose sign-in runs in the system browser and tells nobody directly.
 */
export function ConnectFlow({
  integration,
  onBack,
  onDone,
  onOpenPage,
}: {
  integration: UserIntegration;
  onBack: () => void;
  onDone: () => void;
  onOpenPage: () => void;
}) {
  const desktop = useDesktop();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: "start" });
  const [keyOpen, setKeyOpen] = useState(false);
  // The accounts there were before, so a new one reads as this connection finishing.
  const [known] = useState(() => new Set(integration.connections.map((account) => account.id)));
  const { data } = useQuery(myIntegrationsQuery);
  // Who is asking, which every sign-in link names; until it is known there is no link.
  const { data: me } = useQuery(sessionUserQuery);
  // The window of the sign-in under way: a new one or Cancel closes it, so an earlier
  // sign-in cannot finish behind the dialog's back and add a second account.
  const popup = useRef<Window | null>(null);
  const current = data?.find((entry) => entry.id === integration.id) ?? integration;
  const added = current.connections.find((account) => !known.has(account.id));
  const manifest = findIntegrationType(integration.kind);
  const entry = integrationEntry(integration);
  // A server from a catalog is known by its own name, not its type's.
  const service = manifest?.toolSource === "listed" ? integration.name : manifest?.name;

  const waitingFor = step.kind === "waiting" ? step.attempt : null;
  useEffect(() => {
    if (!waitingFor) return;
    return onSignIn(waitingFor, (outcome) => {
      if (outcome.error) setStep({ kind: "failed", error: outcome.error });
      else void queryClient.invalidateQueries({ queryKey: myIntegrationsQuery.queryKey });
    });
  }, [waitingFor, queryClient]);

  const signIn = (as: string) => {
    const attempt = crypto.randomUUID();
    const url = connectUrl(integration.id, { returnTo: signInLanding(attempt), as });
    popup.current?.close();
    // Opened in the click itself, or the browser blocks it. The desktop app sends
    // it to the system browser and returns no window, which is not a block.
    const opened = window.open(url, `sign-in-${attempt}`, "popup,width=520,height=720");
    popup.current = opened;
    setStep({ kind: "waiting", attempt, url, blocked: !opened && !desktop });
  };
  const restart = () => {
    popup.current?.close();
    popup.current = null;
    setStep({ kind: "start" });
  };

  // A new account, however it came: the sign-in window, a key, the system browser.
  if (added) {
    const tools = added.tools.length;
    return (
      <>
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <span className="bg-primary text-primary-foreground flex size-9 items-center justify-center rounded-full">
            <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-4" />
          </span>
          <p className="font-medium">{integration.name} is ready</p>
          <p className="text-muted-foreground text-sm">
            {tools === 0
              ? "It lists no tools to your account yet."
              : `${tools === 1 ? "1 tool" : `${tools} tools`}. Reads run, changes ask first.`}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onOpenPage}>
            Tool permissions
          </Button>
          <Button onClick={onDone}>Done</Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      {entry ? <DirectoryEntryHeader entry={entry} /> : null}
      {step.kind === "waiting" ? (
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <Spinner />
          <p className="text-sm font-medium">
            {desktop
              ? `Finish signing in to ${service} in your browser`
              : `Finish signing in to ${service} in the new window`}
          </p>
          {step.blocked ? (
            <Button
              size="sm"
              variant="outline"
              render={<a href={step.url} target="_blank" rel="noopener" />}
            >
              Open sign-in window
            </Button>
          ) : null}
        </div>
      ) : step.kind === "failed" ? (
        <FieldError>{step.error}</FieldError>
      ) : (
        <p className="text-muted-foreground text-sm">
          {integration.methods.open
            ? "It needs no account. Chats can use it once it’s on."
            : `Connect your ${service} account. Chats then read for you and ask before they change anything.`}
        </p>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={step.kind === "start" ? onBack : restart}>
          {step.kind === "waiting" ? "Cancel" : "Back"}
        </Button>
        {step.kind === "waiting" ? null : (
          <>
            {integration.methods.apiKey ? (
              <Button
                variant={
                  integration.methods.oauth || integration.methods.open ? "outline" : "default"
                }
                onClick={() => setKeyOpen(true)}
              >
                {step.kind === "failed" && integration.methods.oauth
                  ? `Use ${manifest?.apiKey?.noun ?? "an API key"} instead`
                  : `Use ${manifest?.apiKey?.noun ?? "an API key"}`}
              </Button>
            ) : null}
            {integration.methods.open ? <TurnOnButton integration={integration} /> : null}
            {integration.methods.oauth ? (
              <Button disabled={!me} onClick={() => me && signIn(me.id)}>
                {step.kind === "failed" ? "Try again" : "Sign in"}
              </Button>
            ) : null}
          </>
        )}
      </DialogFooter>
      {keyOpen ? <ApiKeyDialog integration={integration} open onOpenChange={setKeyOpen} /> : null}
    </>
  );
}
