import { ArrowRight01Icon, MoreHorizontalIcon, PlugSocketIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { ToolPermission } from "../consent.ts";
import { useConfirm } from "~/ui/confirm-context.ts";
import { toastError } from "~/ui/error-toast.ts";
import { EmptyState, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { FieldLabel } from "~/ui/primitives/field";
import { Switch } from "~/ui/primitives/switch";
import { findIntegration } from "../catalog.ts";
import { myIntegrationsQuery } from "../client/queries.ts";
import type { UserIntegration } from "../schema.ts";
import { disconnectIntegration, updateIntegrationConnection } from "../server/functions.ts";
import { ApiKeyDialog, ConnectActions, SignInButton } from "./connect-actions.tsx";
import { IntegrationLogo } from "./integration-logo.tsx";
import { ToolPermissions } from "./tool-permissions.tsx";

function StatusBadge({ integration }: { integration: UserIntegration }) {
  const { connection } = integration;
  if (!connection) return null;
  if (!integration.available) return <Badge variant="outline">Turned off</Badge>;
  // Says what happened; the button beside it says what to do.
  if (connection.status === "needs_reauth") return <Badge variant="destructive">Signed out</Badge>;
  return <Badge variant="secondary">Connected</Badge>;
}

export function IntegrationsSettingsPage() {
  const { data } = useSuspenseQuery(myIntegrationsQuery);
  const listed = data.filter((integration) => findIntegration(integration.id));
  return (
    <Page
      title="Integrations"
      description="Connect your own accounts so chats can search, read and, with your approval, change things there."
      rootPath="/settings"
      rootLabel="Settings"
    >
      {listed.length === 0 ? (
        <EmptyState
          icon={PlugSocketIcon}
          title="No integrations yet"
          description="An admin turns integrations on for this instance. Once they do, you can connect your account here."
        />
      ) : (
        <ListCard>
          {listed.map((integration) => {
            const manifest = findIntegration(integration.id)!;
            return (
              <Link
                key={integration.id}
                to="/settings/integrations/$integrationId"
                params={{ integrationId: integration.id }}
                className="block"
              >
                <ListRow interactive>
                  <IntegrationLogo integrationId={integration.id} variant="tile" />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {manifest.name}
                      <StatusBadge integration={integration} />
                    </p>
                    <p className="text-muted-foreground truncate text-xs">{manifest.description}</p>
                  </div>
                  <HugeiconsIcon
                    strokeWidth={2}
                    icon={ArrowRight01Icon}
                    className="text-muted-foreground size-4 shrink-0"
                  />
                </ListRow>
              </Link>
            );
          })}
        </ListCard>
      )}
    </Page>
  );
}

export function IntegrationSettingsPage({ integrationId }: { integrationId: string }) {
  const { data } = useSuspenseQuery(myIntegrationsQuery);
  const integration = data.find((item) => item.id === integrationId);
  const manifest = findIntegration(integrationId);
  if (!integration || !manifest)
    return (
      <Page title="Integration" backTo="/settings/integrations" backLabel="Integrations">
        <EmptyState
          icon={PlugSocketIcon}
          title="Integration not found"
          description="It may have been turned off, or it is not available to you."
        />
      </Page>
    );
  const { connection } = integration;
  const usable = connection && integration.available && connection.status === "active";
  return (
    <Page
      title={manifest.name}
      description={manifest.description}
      backTo="/settings/integrations"
      backLabel="Integrations"
    >
      <Section title="Account">
        <ListCard>
          <AccountRow integration={integration} />
          {usable ? <DefaultRow integration={integration} /> : null}
        </ListCard>
      </Section>
      {usable ? (
        <Section
          title="Tool permissions"
          description="Choose when chats may use each tool. Blocked tools are never offered."
        >
          <PermissionsEditor integration={integration} />
        </Section>
      ) : (
        <Section title="What chats can do">
          <ListCard>
            {manifest.tools.map((tool) => (
              <ListRow key={tool.name}>
                <span className="text-sm">{tool.title}</span>
              </ListRow>
            ))}
          </ListCard>
        </Section>
      )}
    </Page>
  );
}

type ConnectionChanges = {
  offerByDefault?: boolean;
  toolPermissions?: Record<string, ToolPermission>;
};

// Optimistic, so a click changes one control instead of disabling them all
// while the save runs; the last save to settle refetches the truth.
const useConnectionUpdate = (integrationId: string) => {
  const queryClient = useQueryClient();
  const mutationKey = ["integrations", "connection", integrationId];
  const { queryKey } = myIntegrationsQuery;
  return useMutation({
    mutationKey,
    mutationFn: (input: ConnectionChanges) =>
      updateIntegrationConnection({ data: { integrationId, ...input } }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (current) =>
        current?.map((item) =>
          item.id === integrationId && item.connection
            ? {
                ...item,
                connection: {
                  ...item.connection,
                  ...(input.offerByDefault === undefined
                    ? {}
                    : { offerByDefault: input.offerByDefault }),
                  toolPermissions: { ...item.connection.toolPermissions, ...input.toolPermissions },
                },
              }
            : item,
        ),
      );
      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      toastError("Could not save that preference.", error);
    },
    onSettled: () =>
      queryClient.isMutating({ mutationKey }) === 1
        ? queryClient.invalidateQueries({ queryKey })
        : undefined,
  });
};

const plural = (count: number, noun: string) =>
  count === 0 ? null : `${count} ${noun}${count === 1 ? "" : "s"}`;

function AccountRow({ integration }: { integration: UserIntegration }) {
  const manifest = findIntegration(integration.id)!;
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const disconnect = useMutation({
    mutationFn: () => disconnectIntegration({ data: { integrationId: integration.id } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: myIntegrationsQuery.queryKey }),
    onError: (error) => toastError("Could not disconnect.", error),
  });
  const { connection, dependents } = integration;
  const needsReauth = connection?.status === "needs_reauth";
  const affected = [
    plural(dependents.sources, "knowledge source"),
    plural(dependents.schedules, "schedule"),
  ].filter(Boolean);

  const confirmDisconnect = async () => {
    if (
      await confirm({
        title: `Disconnect ${manifest.name}?`,
        description: affected.length
          ? `Chats lose its tools, and ${affected.join(" and ")} stop working until you connect again. Documents already synced stay.`
          : "Chats lose its tools until you connect again.",
        confirmLabel: "Disconnect",
      })
    )
      disconnect.mutate();
  };
  const [keyOpen, setKeyOpen] = useState(false);
  const canConnect = integration.available;
  // A lapsed sign-in gets one way back in; the other method and Disconnect wait in the menu.
  const reconnectWithOAuth = needsReauth && canConnect && integration.methods.oauth;

  return (
    <ListRow>
      <IntegrationLogo integrationId={integration.id} variant="tile" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <span className="truncate" title={connection?.accountLabel}>
            {connection ? connection.accountLabel : "Not connected"}
          </span>
          <StatusBadge integration={integration} />
        </span>
        <span className="text-muted-foreground truncate text-xs">
          {!integration.available
            ? "An admin turned this integration off."
            : needsReauth
              ? `Sign in to ${manifest.name} again to keep using it.`
              : connection
                ? `Chats use ${manifest.name} as this account.`
                : `Connect your ${manifest.name} account to use it in chats.`}
        </span>
      </div>
      {canConnect && !connection ? <ConnectActions integration={integration} /> : null}
      {reconnectWithOAuth ? (
        <SignInButton integration={integration}>Reconnect</SignInButton>
      ) : needsReauth && canConnect && integration.methods.apiKey ? (
        <Button size="sm" onClick={() => setKeyOpen(true)}>
          Reconnect
        </Button>
      ) : null}
      {connection ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Account actions"
                className="text-muted-foreground"
              />
            }
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {reconnectWithOAuth && integration.methods.apiKey ? (
              <DropdownMenuItem onClick={() => setKeyOpen(true)}>
                Use an API key instead
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              variant="destructive"
              // A menu item cannot hold a spinner; disabled is its pending state.
              disabled={disconnect.isPending}
              onClick={() => void confirmDisconnect()}
            >
              Disconnect
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {keyOpen ? <ApiKeyDialog integration={integration} open onOpenChange={setKeyOpen} /> : null}
    </ListRow>
  );
}

function DefaultRow({ integration }: { integration: UserIntegration }) {
  const fieldId = useId();
  const update = useConnectionUpdate(integration.id);
  const connection = integration.connection!;
  return (
    <ListRow className="justify-between">
      <FieldLabel htmlFor={fieldId}>Turn on in new chats</FieldLabel>
      <Switch
        id={fieldId}
        checked={connection.offerByDefault}
        onCheckedChange={(offerByDefault) => update.mutate({ offerByDefault })}
      />
    </ListRow>
  );
}

function PermissionsEditor({ integration }: { integration: UserIntegration }) {
  const update = useConnectionUpdate(integration.id);
  return (
    <ToolPermissions
      integrationId={integration.id}
      permissions={integration.connection!.toolPermissions}
      onChange={(toolPermissions) => update.mutate({ toolPermissions })}
    />
  );
}
