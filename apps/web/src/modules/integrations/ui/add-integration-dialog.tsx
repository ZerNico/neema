import { Add01Icon, PlugSocketIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Spinner } from "~/ui/primitives/spinner";
import { Switch } from "~/ui/primitives/switch";
import { integrationLook } from "../client/directory.ts";
import { myIntegrationsQuery, personalServersQuery } from "../client/queries.ts";
import type { ComposerIntegrations } from "../client/use-chat-integrations.ts";
import type { UserIntegration } from "../schema.ts";
import { SignInButton } from "./connect-actions.tsx";
import { IntegrationLogo } from "./integration-logo.tsx";
import { PersonalServerDialog } from "./personal-server-dialog.tsx";

/**
 * What this chat may use: each connected account with its switch. Connecting
 * something new is the same step as in Settings, one button away.
 */
export function AddIntegrationDialog({
  open,
  onOpenChange,
  chat,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chat: ComposerIntegrations;
}) {
  const mine = useQuery({ ...myIntegrationsQuery, enabled: open });
  const personal = useQuery({ ...personalServersQuery, enabled: open });
  const [adding, setAdding] = useState(false);
  const list = mine.data ?? [];
  const connected = list.filter((integration) => integration.connections.length > 0);
  const toConnect = list.filter(
    (integration) =>
      integration.available && !integration.personal && integration.connections.length === 0,
  );
  const mayAdd = toConnect.length > 0 || Boolean(personal.data?.canAdd);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Integrations</DialogTitle>
          <DialogDescription>Choose what this chat can use.</DialogDescription>
        </DialogHeader>
        {mine.isPending ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Spinner /> Loading…
          </div>
        ) : connected.length === 0 && !mayAdd ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 py-6 text-center text-sm">
            <HugeiconsIcon icon={PlugSocketIcon} strokeWidth={2} className="size-5" />
            No integrations are set up on this instance yet. An admin can add them under Admin →
            Integrations.
          </div>
        ) : (
          <ul className="flex min-w-0 flex-col gap-2">
            {connected.map((integration) => (
              <ChatIntegrationRow key={integration.id} integration={integration} chat={chat} />
            ))}
            {mayAdd ? (
              <li>
                <button
                  type="button"
                  className="border-border hover:bg-accent/50 focus-visible:ring-ring/30 flex w-full items-center gap-3 rounded-2xl border border-dashed px-3 py-3 text-left text-sm font-medium transition-colors outline-none focus-visible:ring-[3px]"
                  onClick={() => setAdding(true)}
                >
                  <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-2xl">
                    <HugeiconsIcon icon={Add01Icon} strokeWidth={2} className="size-4" />
                  </span>
                  Add integration
                </button>
              </li>
            ) : null}
          </ul>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            className="sm:mr-auto"
            render={<Link to="/settings/integrations" />}
          >
            Manage integrations
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
      {adding && personal.data ? (
        <PersonalServerDialog
          server={null}
          choices={personal.data}
          shared={toConnect}
          open
          onOpenChange={setAdding}
        />
      ) : null}
    </Dialog>
  );
}

/**
 * One connected integration: a switch per account in this chat, or the one
 * thing to do when it cannot be used as it is.
 */
function ChatIntegrationRow({
  integration,
  chat,
}: {
  integration: UserIntegration;
  chat: ComposerIntegrations;
}) {
  const returnTo = useRouterState({ select: (state) => state.location.pathname });
  const manifest = integrationLook(integration);
  if (!manifest) return null;
  const here = chat.items.filter((item) => item.integrationId === integration.id);
  const lapsed = integration.connections.find((account) => account.status === "needs_reauth");
  const several = here.length > 1;

  const action = !integration.available ? (
    <Badge variant="outline">Turned off</Badge>
  ) : lapsed && here.length === 0 ? (
    integration.methods.oauth ? (
      <SignInButton integration={integration} connectionId={lapsed.id} returnTo={returnTo}>
        Reconnect
      </SignInButton>
    ) : (
      <Button
        size="sm"
        render={
          <Link
            to="/settings/integrations/$integrationId"
            params={{ integrationId: integration.id }}
          />
        }
      >
        Reconnect
      </Button>
    )
  ) : here.length === 1 ? (
    <Switch
      checked={here[0]!.enabled}
      aria-label={`Use ${integration.name} in this chat`}
      onCheckedChange={(enabled) => chat.setEnabled(here[0]!.connectionId, enabled)}
    />
  ) : null;

  return (
    <li className="border-border flex flex-col gap-2 rounded-2xl border px-3 py-3">
      <div className="flex items-center gap-3">
        <IntegrationLogo integrationId={integration.id} variant="tile" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2 text-sm font-medium">
            {integration.name}
            {lapsed && here.length > 0 ? <Badge variant="destructive">Reconnect</Badge> : null}
          </span>
          {/* Accounts tell themselves apart below; one is just the service. */}
          <span className="text-muted-foreground truncate text-xs">{manifest.description}</span>
        </div>
        {action}
      </div>
      {integration.available && several ? (
        <ul className="flex flex-col gap-2 pl-12">
          {here.map((item) => (
            <li key={item.connectionId} className="flex items-center justify-between gap-3">
              <span className="truncate text-sm">{item.account ?? integration.name}</span>
              <Switch
                checked={item.enabled}
                aria-label={`Use ${item.account ?? integration.name} in this chat`}
                onCheckedChange={(enabled) => chat.setEnabled(item.connectionId, enabled)}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
