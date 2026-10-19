import {
  ArrowRight01Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  PlugSocketIcon,
} from "@hugeicons/core-free-icons";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { FieldLabel } from "~/ui/primitives/field";
import { Switch } from "~/ui/primitives/switch";
import { findIntegrationType } from "../catalog.ts";
import { connectUrl, myIntegrationsQuery, personalServersQuery } from "../client/queries.ts";
import { hasPendingChanges } from "../mcp/catalog.ts";
import { useDesktop } from "~/modules/desktop/client/bridge.ts";
import type { PersonalServer, UserIntegration } from "../schema.ts";
import { disconnectIntegration, updateIntegrationConnection } from "../server/functions.ts";
import { ApiKeyDialog, ConnectActions, SignInButton, TurnOnButton } from "./connect-actions.tsx";
import { IntegrationLogo } from "./integration-logo.tsx";
import { IntegrationScopeSection } from "./integration-scope.tsx";
import { McpToolsReview } from "./mcp-tools-review.tsx";
import { useDeletePersonalServer } from "../client/use-delete-personal-server.ts";
import { PersonalServerDialog } from "./personal-server-dialog.tsx";
import { ToolPermissions } from "./tool-permissions.tsx";

const withoutAccountKind = (connection: UserIntegration["connection"]) =>
  connection?.authKind === "none" || connection?.authKind === "shared";

function StatusBadge({ integration }: { integration: UserIntegration }) {
  const { connection } = integration;
  if (!connection) return null;
  if (!integration.available) return <Badge variant="outline">Turned off</Badge>;
  // Says what happened; the button beside it says what to do.
  if (connection.status === "needs_reauth")
    return (
      <Badge variant="destructive">
        {connection.authKind === "shared" || connection.authKind === "none"
          ? "Paused"
          : "Signed out"}
      </Badge>
    );
  return <Badge variant="secondary">Connected</Badge>;
}

export function IntegrationsSettingsPage() {
  const { data } = useSuspenseQuery(myIntegrationsQuery);
  const { data: personal } = useSuspenseQuery(personalServersQuery);
  const [adding, setAdding] = useState(false);
  const listed = data.filter((integration) => findIntegrationType(integration.kind));
  const shared = listed.filter((integration) => !integration.personal);
  const own = listed.filter((integration) => integration.personal);
  const addButton = (
    <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
      Add MCP server
    </Button>
  );
  return (
    <Page
      title="Integrations"
      description="Connect your own accounts so chats can search, read and, with your approval, change things there."
      rootPath="/settings"
      rootLabel="Settings"
    >
      {adding ? <PersonalServerDialog server={null} open onOpenChange={setAdding} /> : null}
      {/* Without servers of one's own there is nothing to tell these apart from. */}
      {personal.canAdd || own.length ? (
        shared.length ? (
          <Section title="From your admin">
            <IntegrationList integrations={shared} />
          </Section>
        ) : null
      ) : shared.length ? (
        <IntegrationList integrations={shared} />
      ) : (
        <EmptyState
          icon={PlugSocketIcon}
          title="No integrations yet"
          description="An admin turns integrations on for this instance. Once they do, you can connect your account here."
        />
      )}
      {personal.canAdd || own.length ? (
        <Section
          title="Your MCP servers"
          description="Servers you added. Only you can use them."
          actions={personal.canAdd && own.length ? addButton : null}
        >
          {own.length ? (
            <IntegrationList integrations={own} />
          ) : (
            <EmptyState
              icon={PlugSocketIcon}
              title="No servers of your own"
              description="Add a public MCP server to use its tools in your chats."
              action={addButton}
            />
          )}
        </Section>
      ) : null}
    </Page>
  );
}

function IntegrationList({ integrations }: { integrations: ReadonlyArray<UserIntegration> }) {
  return (
    <ListCard>
      {integrations.map((integration) => {
        const manifest = findIntegrationType(integration.kind)!;
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
                  {integration.name}
                  <StatusBadge integration={integration} />
                </p>
                <p className="text-muted-foreground truncate text-xs">
                  {integration.personal ? "Only you use it" : manifest.description}
                </p>
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
  );
}

export function IntegrationSettingsPage({ integrationId }: { integrationId: string }) {
  const { data } = useSuspenseQuery(myIntegrationsQuery);
  const { data: personal } = useSuspenseQuery(personalServersQuery);
  const integration = data.find((item) => item.id === integrationId);
  const server = personal.servers.find((item) => item.id === integrationId) ?? null;
  const [editing, setEditing] = useState(false);
  const manifest = integration ? findIntegrationType(integration.kind) : null;
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
      title={integration.name}
      description={server ? "Your MCP server. Only you can use it." : manifest.description}
      backTo="/settings/integrations"
      backLabel="Integrations"
      actions={server ? <ServerActions server={server} onEdit={() => setEditing(true)} /> : null}
    >
      {server ? <ServerSection server={server} /> : null}
      {server && editing ? (
        <PersonalServerDialog server={server} open onOpenChange={setEditing} />
      ) : null}
      <Section title="Account">
        <ListCard>
          <AccountRow integration={integration} />
          {usable ? <DefaultRow integration={integration} /> : null}
        </ListCard>
      </Section>
      {usable && manifest.scope ? <ScopeSection integration={integration} /> : null}
      {integration.tools.length === 0 ? (
        <Section title="What chats can do">
          <EmptyState
            icon={PlugSocketIcon}
            title="No tools yet"
            description={
              server
                ? "Review this server’s tools to choose which ones chats may use."
                : "An admin approves which of this server’s tools chats may use."
            }
          />
        </Section>
      ) : usable ? (
        <Section
          title="Tool permissions"
          description={
            connection.authKind === "shared"
              ? "Chats only read with a key everyone shares. Choose when they may."
              : "Choose when chats may use each tool. Blocked tools are never offered."
          }
        >
          <PermissionsEditor integration={integration} />
        </Section>
      ) : (
        <Section title="What chats can do">
          <ListCard>
            {integration.tools.map((tool) => (
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

/** Changing or deleting one's own server, in the page's menu like other detail pages. */
function ServerActions({ server, onEdit }: { server: PersonalServer; onEdit: () => void }) {
  const remove = useDeletePersonalServer();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button size="icon-sm" variant="ghost" aria-label="Server actions" />}
      >
        <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onEdit}>
          <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
          Edit server
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* A menu item cannot hold a spinner; disabled is its pending state. */}
        <DropdownMenuItem
          variant="destructive"
          disabled={remove.pending}
          onClick={() => void remove.request(server)}
        >
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
          Delete server
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A person's own server: where it is, and their review of its tools. */
function ServerSection({ server }: { server: PersonalServer }) {
  const [reviewing, setReviewing] = useState(false);
  const { catalog } = server;
  const waiting =
    catalog.latest !== null &&
    (hasPendingChanges(catalog.approved, catalog.latest) || !catalog.reviewedAt);
  return (
    <Section title="Server">
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
              <span className="truncate">{server.config.url}</span>
              {waiting ? <Badge variant="secondary">Tools to review</Badge> : null}
            </span>
            <span className="text-muted-foreground truncate text-xs">
              {catalog.checkError ??
                `${catalog.approved.filter((entry) => entry.enabled).length} tools approved`}
            </span>
          </div>
          <Button size="sm" variant="outline" onClick={() => setReviewing(true)}>
            Review tools
          </Button>
        </ListRow>
      </ListCard>
      {reviewing ? <McpToolsReview row={server} personal onOpenChange={setReviewing} /> : null}
    </Section>
  );
}

type ConnectionChanges = {
  offerByDefault?: boolean;
  toolPermissions?: Record<string, ToolPermission>;
  scope?: string[] | null;
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
                  ...(input.scope === undefined ? {} : { scope: input.scope }),
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
        title: `Disconnect ${integration.name}?`,
        description: integration.methods.everyone
          ? "Chats go back to using it without an account."
          : affected.length
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
  // Used without an account, it can take one of the person's own for more.
  const withoutAccount = canConnect && !needsReauth && withoutAccountKind(connection);
  const desktop = useDesktop();
  // On for everyone: without an account it is back on the next time it is read.
  const canDisconnect = !(integration.methods.everyone && withoutAccountKind(connection));
  const menu =
    ((reconnectWithOAuth || withoutAccount) && integration.methods.apiKey) ||
    (withoutAccount && integration.methods.oauth) ||
    canDisconnect;

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
            : needsReauth && integration.methods.open
              ? `${integration.name} changed. Turn it on again to keep using it.`
              : needsReauth
                ? `Sign in to ${integration.name} again to keep using it.`
                : connection?.authKind === "shared"
                  ? "Everyone here uses one key, so chats only read."
                  : connection?.authKind === "none"
                    ? integration.methods.apiKey || integration.methods.oauth
                      ? "Used without an account."
                      : `${integration.name} needs no account.`
                    : connection
                      ? `Chats use ${integration.name} as this account.`
                      : integration.methods.open
                        ? `Turn ${integration.name} on to use it in chats.`
                        : `Connect your ${integration.name} account to use it in chats.`}
        </span>
      </div>
      {canConnect && !connection ? <ConnectActions integration={integration} /> : null}
      {canConnect &&
      !needsReauth &&
      connection?.requiredScopes?.length &&
      integration.methods.oauth ? (
        // A call needed more than this sign-in granted; signing in again asks for both.
        <SignInButton integration={integration}>Grant more access</SignInButton>
      ) : null}
      {reconnectWithOAuth ? (
        <SignInButton integration={integration}>Reconnect</SignInButton>
      ) : needsReauth && canConnect && integration.methods.open ? (
        <TurnOnButton integration={integration}>Turn on again</TurnOnButton>
      ) : needsReauth && canConnect && integration.methods.apiKey ? (
        <Button size="sm" onClick={() => setKeyOpen(true)}>
          Reconnect
        </Button>
      ) : null}
      {connection && menu ? (
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
            {(reconnectWithOAuth || withoutAccount) && integration.methods.apiKey ? (
              <DropdownMenuItem onClick={() => setKeyOpen(true)}>
                Use {findIntegrationType(integration.kind)?.apiKey?.noun ?? "an API key"} instead
              </DropdownMenuItem>
            ) : null}
            {withoutAccount && integration.methods.oauth ? (
              <DropdownMenuItem
                render={
                  <a href={connectUrl(integration.id)} target={desktop ? "_blank" : undefined} />
                }
              >
                Sign in with {integration.name}
              </DropdownMenuItem>
            ) : null}
            {canDisconnect ? (
              <DropdownMenuItem
                variant="destructive"
                // A menu item cannot hold a spinner; disabled is its pending state.
                disabled={disconnect.isPending}
                onClick={() => void confirmDisconnect()}
              >
                Disconnect
              </DropdownMenuItem>
            ) : null}
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

function ScopeSection({ integration }: { integration: UserIntegration }) {
  const update = useConnectionUpdate(integration.id);
  return (
    <IntegrationScopeSection
      integration={integration}
      onChange={(scope) => update.mutate({ scope })}
    />
  );
}

function PermissionsEditor({ integration }: { integration: UserIntegration }) {
  const update = useConnectionUpdate(integration.id);
  return (
    <ToolPermissions
      kind={integration.kind}
      byAccess={!integration.personal}
      // Shared keys only ever read, so their other tools have nothing to set.
      tools={
        integration.connection?.authKind === "shared"
          ? integration.tools.filter((tool) => tool.access === "read")
          : integration.tools
      }
      permissions={integration.connection!.toolPermissions}
      onChange={(toolPermissions) => update.mutate({ toolPermissions })}
    />
  );
}
