import { PlugSocketIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
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
import { myIntegrationsQuery } from "../client/queries.ts";
import type { ComposerIntegrations } from "../client/use-chat-integrations.ts";
import { ConnectActions } from "./connect-actions.tsx";
import { IntegrationLogo } from "./integration-logo.tsx";

/**
 * Every integration this person may use, connectable from inside a chat. A
 * sign-in leaves the page and comes back here; connected ones can be turned
 * on or off for this chat directly.
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
  const returnTo = useRouterState({ select: (state) => state.location.pathname });
  const list = mine.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Integrations</DialogTitle>
          <DialogDescription>
            Connect your own accounts so this chat can search, read and, with your approval, change
            things there.
          </DialogDescription>
        </DialogHeader>
        {mine.isPending ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Spinner /> Loading…
          </div>
        ) : list.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 py-6 text-center text-sm">
            <HugeiconsIcon icon={PlugSocketIcon} strokeWidth={2} className="size-5" />
            No integrations are set up on this instance yet. An admin can add them under Admin →
            Integrations.
          </div>
        ) : (
          <ul className="flex min-w-0 flex-col gap-2">
            {list.map((integration) => {
              const manifest = integrationLook(integration);
              if (!manifest) return null;
              // Each working account it has in this chat, switched on its own.
              const here = chat.items.filter((item) => item.integrationId === integration.id);
              const lapsed = integration.connections.some(
                (account) => account.status === "needs_reauth",
              );
              return (
                <li
                  key={integration.id}
                  className="border-border flex flex-wrap items-center gap-3 rounded-2xl border px-3 py-3"
                >
                  <IntegrationLogo integrationId={integration.id} variant="tile" />
                  <div className="flex min-w-0 flex-1 basis-40 flex-col">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {integration.name}
                      {lapsed ? <Badge variant="destructive">Reconnect</Badge> : null}
                    </span>
                    {here.length <= 1 ? (
                      <span className="text-muted-foreground truncate text-xs">
                        {here[0]?.account ?? (here.length ? "" : manifest.description)}
                      </span>
                    ) : null}
                  </div>
                  {integration.available && here.length === 1 ? (
                    <Switch
                      checked={here[0]!.enabled}
                      aria-label={`Use ${integration.name} in this chat`}
                      onCheckedChange={(enabled) => chat.setEnabled(here[0]!.connectionId, enabled)}
                    />
                  ) : integration.available && here.length > 1 ? (
                    <ul className="flex w-full flex-col gap-2 pl-12">
                      {here.map((item) => (
                        <li
                          key={item.connectionId}
                          className="flex items-center justify-between gap-3"
                        >
                          <span className="truncate text-sm">
                            {item.account ?? integration.name}
                          </span>
                          <Switch
                            checked={item.enabled}
                            aria-label={`Use ${item.account ?? integration.name} in this chat`}
                            onCheckedChange={(enabled) =>
                              chat.setEnabled(item.connectionId, enabled)
                            }
                          />
                        </li>
                      ))}
                    </ul>
                  ) : integration.available ? (
                    <ConnectActions integration={integration} returnTo={returnTo} />
                  ) : (
                    <Badge variant="outline">Turned off</Badge>
                  )}
                </li>
              );
            })}
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
    </Dialog>
  );
}
