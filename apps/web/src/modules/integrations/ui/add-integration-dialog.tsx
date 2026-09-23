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
import { findIntegration } from "../catalog.ts";
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
              const manifest = findIntegration(integration.id);
              if (!manifest) return null;
              const connection = integration.connection;
              const ready = integration.available && connection?.status === "active";
              const here = chat.items.find((item) => item.integrationId === integration.id);
              return (
                <li
                  key={integration.id}
                  className="border-border flex flex-wrap items-center gap-3 rounded-2xl border px-3 py-3"
                >
                  <IntegrationLogo integrationId={integration.id} variant="tile" />
                  <div className="flex min-w-0 flex-1 basis-40 flex-col">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {manifest.name}
                      {connection?.status === "needs_reauth" ? (
                        <Badge variant="destructive">Reconnect</Badge>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground truncate text-xs">
                      {connection ? connection.accountLabel : manifest.description}
                    </span>
                  </div>
                  {ready && here ? (
                    <Switch
                      checked={here.enabled}
                      aria-label={`Use ${manifest.name} in this chat`}
                      onCheckedChange={(enabled) => chat.setEnabled(integration.id, enabled)}
                    />
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
