import {
  Add01Icon,
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
import { PendingButton } from "~/ui/pending-button.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Field, FieldError, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Switch } from "~/ui/primitives/switch";
import { integrationLook } from "../client/directory.ts";
import { myIntegrationsQuery, personalServersQuery } from "../client/queries.ts";
import { knownMcpServerWithUrl } from "../mcp/known-servers.ts";
import {
  accountName,
  usesNoAccount,
  type IntegrationConnectionView,
  type PersonalServer,
  type UserIntegration,
} from "../schema.ts";
import {
  checkOwnTools,
  disconnectIntegration,
  updateIntegrationConnection,
} from "../server/functions.ts";
import { ApiKeyDialog, ConnectActions, SignInButton, TurnOnButton } from "./connect-actions.tsx";
import { IntegrationLogo } from "./integration-logo.tsx";
import { IntegrationScopeSection } from "./integration-scope.tsx";
import { useDeletePersonalServer } from "../client/use-delete-personal-server.ts";
import { PersonalServerDialog } from "./personal-server-dialog.tsx";
import { ToolPermissions } from "./tool-permissions.tsx";

type Account = IntegrationConnectionView;

/** How the list sums up an integration: its one account's state, or how many are connected. */
function StatusBadge({ integration }: { integration: UserIntegration }) {
  const { connections } = integration;
  if (connections.length === 0) return null;
  if (!integration.available) return <Badge variant="outline">Turned off</Badge>;
  if (connections.length > 1) {
    const lapsed = connections.filter((account) => account.status === "needs_reauth").length;
    return lapsed ? (
      <Badge variant="destructive">{lapsed === 1 ? "1 signed out" : `${lapsed} signed out`}</Badge>
    ) : (
      <Badge variant="secondary">{connections.length} accounts</Badge>
    );
  }
  return <AccountBadge account={connections[0]!} />;
}

function AccountBadge({ account }: { account: Account }) {
  // Says what happened; the button beside it says what to do.
  if (account.status === "needs_reauth")
    return (
      <Badge variant="destructive">
        {usesNoAccount(account.authKind) ? "Paused" : "Signed out"}
      </Badge>
    );
  return <Badge variant="secondary">Connected</Badge>;
}

export function IntegrationsSettingsPage() {
  const { data } = useSuspenseQuery(myIntegrationsQuery);
  const { data: personal } = useSuspenseQuery(personalServersQuery);
  const [adding, setAdding] = useState(false);
  const listed = data.filter((integration) => integrationLook(integration));
  // Yours: what you connected or added. The rest waits in the directory.
  const yours = listed.filter(
    (integration) => integration.personal || integration.connections.length > 0,
  );
  const toConnect = listed.filter(
    (integration) =>
      integration.available && !integration.personal && integration.connections.length === 0,
  );
  const mayAdd = toConnect.length > 0 || personal.canAdd;
  const addButton = (
    <Button size="sm" onClick={() => setAdding(true)}>
      <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
      Add integration
    </Button>
  );
  return (
    <Page
      title="Integrations"
      description="Connect your own accounts so chats can search, read and, with your approval, change things there."
      rootPath="/settings"
      rootLabel="Settings"
      actions={mayAdd && yours.length ? addButton : null}
    >
      {adding ? (
        <PersonalServerDialog
          server={null}
          choices={personal}
          shared={toConnect}
          open
          onOpenChange={setAdding}
        />
      ) : null}
      {yours.length ? (
        <IntegrationList integrations={yours} />
      ) : mayAdd ? (
        <EmptyState
          icon={PlugSocketIcon}
          title="Nothing connected yet"
          description="Add an integration to use its tools in your chats."
          action={addButton}
        />
      ) : (
        <EmptyState
          icon={PlugSocketIcon}
          title="No integrations yet"
          description="An admin turns integrations on for this instance. Once they do, you can connect your account here."
        />
      )}
    </Page>
  );
}

function IntegrationList({ integrations }: { integrations: ReadonlyArray<UserIntegration> }) {
  return (
    <ListCard>
      {integrations.map((integration) => {
        const manifest = integrationLook(integration)!;
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
                  {integration.personal ? "Your own server" : manifest.description}
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
  const manifest = integration ? integrationLook(integration) : null;
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
  return (
    <Page
      title={integration.name}
      description={server ? "Your MCP server. Only you can use it." : manifest.description}
      backTo="/settings/integrations"
      backLabel="Integrations"
      actions={server ? <ServerActions server={server} onEdit={() => setEditing(true)} /> : null}
    >
      {server && editing ? (
        <PersonalServerDialog server={server} choices={personal} open onOpenChange={setEditing} />
      ) : null}
      {server ? <ServerSection server={server} /> : null}
      <IntegrationDetails integration={integration} server={server} />
    </Page>
  );
}

function IntegrationDetails({
  integration,
  server,
}: {
  integration: UserIntegration;
  server: PersonalServer | null;
}) {
  const accounts = integration.connections;
  const working = integration.available
    ? accounts.filter((account) => account.status === "active")
    : [];
  return (
    <>
      <Section title={accounts.length > 1 ? "Accounts" : "Account"}>
        <ListCard>
          {accounts.length === 0 ? (
            <NotConnectedRow integration={integration} />
          ) : (
            accounts.map((account) => (
              <AccountRow
                key={account.id}
                integration={integration}
                account={account}
                several={accounts.length > 1}
              />
            ))
          )}
          {accounts.length > 0 && integration.available && addsAccounts(integration) ? (
            <AddAccountRow integration={integration} />
          ) : null}
        </ListCard>
      </Section>
      {working.length ? (
        // Each account decides for itself: when it is on, what it reaches, what may run unasked.
        working.map((account) => (
          <AccountSettings
            key={account.id}
            integration={integration}
            account={account}
            titled={accounts.length > 1}
          />
        ))
      ) : integration.tools.length === 0 ? (
        <Section title="What chats can do">
          <EmptyState
            icon={PlugSocketIcon}
            title="No tools yet"
            description={
              server
                ? "The server lists none yet. Check again once it does."
                : "Its tools show once you connect."
            }
          />
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
    </>
  );
}

/** Ways in that add an account of one's own, beside any there already are. */
const addsAccounts = (integration: UserIntegration) =>
  integration.methods.oauth || integration.methods.apiKey;

function AccountSettings({
  integration,
  account,
  titled,
}: {
  integration: UserIntegration;
  account: Account;
  titled: boolean;
}) {
  const manifest = integrationLook(integration)!;
  const update = useConnectionUpdate(account.id);
  const fieldId = useId();
  const name = accountName(account);
  return (
    <>
      <Section title={titled ? name : "In chats"}>
        <ListCard>
          <ListRow className="justify-between">
            <FieldLabel htmlFor={fieldId}>Turn on in new chats</FieldLabel>
            <Switch
              id={fieldId}
              checked={account.offerByDefault}
              onCheckedChange={(offerByDefault) => update.mutate({ offerByDefault })}
            />
          </ListRow>
        </ListCard>
      </Section>
      {manifest.scope ? (
        <IntegrationScopeSection
          integration={integration}
          connection={account}
          onChange={(scope) => update.mutate({ scope })}
        />
      ) : null}
      <Section
        title={titled ? `Tool permissions · ${name}` : "Tool permissions"}
        description={
          account.authKind === "shared"
            ? "Chats only read with a key everyone shares. Choose when they may."
            : "Choose when chats may use each tool. Blocked tools are never offered."
        }
        actions={account.listing ? <CheckToolsButton integrationId={integration.id} /> : null}
      >
        {account.listing?.checkError ? <FieldError>{account.listing.checkError}</FieldError> : null}
        {account.tools.length ? (
          <ToolPermissions
            kind={integration.kind}
            // Shared keys only ever read, so the server leaves their other tools out.
            tools={account.tools}
            permissions={account.toolPermissions}
            onChange={(toolPermissions) => update.mutate({ toolPermissions })}
          />
        ) : (
          <EmptyState
            icon={PlugSocketIcon}
            title="No tools yet"
            description="The server lists none to this account yet."
          />
        )}
      </Section>
    </>
  );
}

/** Asks the server again what it offers this person's accounts, instead of waiting for the sweep. */
function CheckToolsButton({ integrationId }: { integrationId: string }) {
  const queryClient = useQueryClient();
  const check = useMutation({
    mutationFn: () => checkOwnTools({ data: { integrationId } }),
    onSuccess: async (result) => {
      if (!result.ok) toastError("Could not check its tools.", new Error(result.error));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: personalServersQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: myIntegrationsQuery.queryKey }),
      ]);
    },
    onError: (error) => toastError("Could not check its tools.", error),
  });
  return (
    <PendingButton
      size="sm"
      variant="outline"
      pending={check.isPending}
      onClick={() => check.mutate()}
    >
      Check again
    </PendingButton>
  );
}

/** Changing or removing one's own server, in the page's menu like other detail pages. */
function ServerActions({ server, onEdit }: { server: PersonalServer; onEdit: () => void }) {
  const remove = useDeletePersonalServer();
  // A known server's address and sign-in come with it; only its name is one's own.
  const known = knownMcpServerWithUrl(server.config.url);
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
          {known ? "Rename" : "Edit server"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* A menu item cannot hold a spinner; disabled is its pending state. */}
        <DropdownMenuItem
          variant="destructive"
          disabled={remove.pending}
          onClick={() => void remove.request(server)}
        >
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A person's own server: where it is, and how many tools it gives chats. */
function ServerSection({ server }: { server: PersonalServer }) {
  const { listing } = server;
  const tools = listing?.count ?? 0;
  return (
    <Section title="Server">
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{server.config.url}</span>
            <span className="text-muted-foreground truncate text-xs">
              {listing?.checkError ?? (tools === 1 ? "1 tool" : `${tools} tools`)}
            </span>
          </div>
          <CheckToolsButton integrationId={server.id} />
        </ListRow>
      </ListCard>
    </Section>
  );
}

type ConnectionChanges = {
  offerByDefault?: boolean;
  toolPermissions?: Record<string, ToolPermission>;
  scope?: string[] | null;
  name?: string | null;
};

// Optimistic, so a click changes one control instead of disabling them all
// while the save runs; the last save to settle refetches the truth.
const useConnectionUpdate = (connectionId: string) => {
  const queryClient = useQueryClient();
  const mutationKey = ["integrations", "connection", connectionId];
  const { queryKey } = myIntegrationsQuery;
  return useMutation({
    mutationKey,
    mutationFn: (input: ConnectionChanges) =>
      updateIntegrationConnection({ data: { connectionId, ...input } }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (current) =>
        current?.map((item) => ({
          ...item,
          connections: item.connections.map((account) =>
            account.id === connectionId
              ? {
                  ...account,
                  ...(input.offerByDefault === undefined
                    ? {}
                    : { offerByDefault: input.offerByDefault }),
                  toolPermissions: { ...account.toolPermissions, ...input.toolPermissions },
                  ...(input.scope === undefined ? {} : { scope: input.scope }),
                  ...(input.name === undefined ? {} : { name: input.name }),
                }
              : account,
          ),
        })),
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

/** No account yet: the ways in, as the admin allowed them. */
function NotConnectedRow({ integration }: { integration: UserIntegration }) {
  return (
    <ListRow>
      <IntegrationLogo integrationId={integration.id} variant="tile" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">Not connected</span>
        <span className="text-muted-foreground truncate text-xs">
          {!integration.available
            ? "An admin turned this integration off."
            : integration.methods.open
              ? `Turn ${integration.name} on to use it in chats.`
              : `Connect your ${integration.name} account to use it in chats.`}
        </span>
      </div>
      {integration.available ? <ConnectActions integration={integration} /> : null}
    </ListRow>
  );
}

/** Another account beside the ones there are, say work and personal mail. */
function AddAccountRow({ integration }: { integration: UserIntegration }) {
  const replaces = integration.connections.every((account) => usesNoAccount(account.authKind));
  return (
    <ListRow>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">
          {replaces ? "Use your own account" : "Add another account"}
        </span>
        <span className="text-muted-foreground truncate text-xs">
          {replaces
            ? "It replaces using it without one."
            : "Chats with more than one on ask which to use."}
        </span>
      </div>
      <ConnectActions integration={integration} another />
    </ListRow>
  );
}

function AccountRow({
  integration,
  account,
  several,
}: {
  integration: UserIntegration;
  account: Account;
  several: boolean;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const disconnect = useMutation({
    mutationFn: () => disconnectIntegration({ data: { connectionId: account.id } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: myIntegrationsQuery.queryKey }),
    onError: (error) => toastError("Could not disconnect.", error),
  });
  const { dependents } = account;
  const name = accountName(account);
  const needsReauth = account.status === "needs_reauth";
  const noAccount = usesNoAccount(account.authKind);
  const affected = [
    plural(dependents.sources, "knowledge source"),
    plural(dependents.schedules, "schedule"),
  ].filter(Boolean);

  const confirmDisconnect = async () => {
    if (
      await confirm({
        title: `Disconnect “${name}”?`,
        description:
          integration.methods.everyone && integration.connections.length === 1
            ? "Chats go back to using it without an account."
            : affected.length
              ? `Chats lose it, and ${affected.join(" and ")} stop working until you connect it again. Documents already synced stay.`
              : "Chats lose it until you connect it again.",
        confirmLabel: "Disconnect",
      })
    )
      disconnect.mutate();
  };
  const [keyOpen, setKeyOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const canConnect = integration.available;
  const reconnectWithOAuth =
    needsReauth && canConnect && account.authKind === "oauth" && integration.methods.oauth;
  const reconnectWithKey =
    needsReauth && canConnect && account.authKind === "api_key" && integration.methods.apiKey;
  // On for everyone: without an account it is back on the next time it is read.
  const canDisconnect = !(integration.methods.everyone && noAccount);
  const canReplaceKey =
    account.authKind === "api_key" && integration.methods.apiKey && !reconnectWithKey;
  const menu = !noAccount || canReplaceKey || canDisconnect;

  return (
    <ListRow>
      <IntegrationLogo integrationId={integration.id} variant="tile" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <span className="truncate" title={account.accountLabel}>
            {name}
          </span>
          {integration.available ? (
            <AccountBadge account={account} />
          ) : (
            <Badge variant="outline">Turned off</Badge>
          )}
        </span>
        <span className="text-muted-foreground truncate text-xs">
          {!integration.available
            ? "An admin turned this integration off."
            : needsReauth && noAccount
              ? `${integration.name} changed. Turn it on again to keep using it.`
              : needsReauth
                ? `Sign in to ${integration.name} again to keep using it.`
                : account.authKind === "shared"
                  ? "Everyone here uses one key, so chats only read."
                  : account.authKind === "none"
                    ? addsAccounts(integration)
                      ? "Used without an account."
                      : `${integration.name} needs no account.`
                    : account.name
                      ? account.accountLabel
                      : several
                        ? "Name it to tell your accounts apart."
                        : `Chats use ${integration.name} as this account.`}
        </span>
      </div>
      {canConnect &&
      !needsReauth &&
      account.requiredScopes?.length &&
      account.authKind === "oauth" &&
      integration.methods.oauth ? (
        // A call needed more than this sign-in granted; signing in again asks for both.
        <SignInButton integration={integration} connectionId={account.id}>
          Grant more access
        </SignInButton>
      ) : null}
      {reconnectWithOAuth ? (
        <SignInButton integration={integration} connectionId={account.id}>
          Reconnect
        </SignInButton>
      ) : needsReauth && canConnect && noAccount && integration.methods.open ? (
        <TurnOnButton integration={integration}>Turn on again</TurnOnButton>
      ) : reconnectWithKey ? (
        <Button size="sm" onClick={() => setKeyOpen(true)}>
          Reconnect
        </Button>
      ) : null}
      {menu ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Actions for ${name}`}
                className="text-muted-foreground"
              />
            }
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {noAccount ? null : (
              <DropdownMenuItem onClick={() => setRenaming(true)}>Rename</DropdownMenuItem>
            )}
            {canReplaceKey ? (
              <DropdownMenuItem onClick={() => setKeyOpen(true)}>Replace key</DropdownMenuItem>
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
      {keyOpen ? (
        <ApiKeyDialog
          integration={integration}
          connectionId={account.id}
          open
          onOpenChange={setKeyOpen}
        />
      ) : null}
      {renaming ? <RenameDialog account={account} onOpenChange={setRenaming} /> : null}
    </ListRow>
  );
}

function RenameDialog({
  account,
  onOpenChange,
}: {
  account: Account;
  onOpenChange: (open: boolean) => void;
}) {
  const fieldId = useId();
  const [name, setName] = useState(account.name ?? "");
  const update = useConnectionUpdate(account.id);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename account</DialogTitle>
          <DialogDescription>
            Shown in chats and approvals. Leave it empty for {account.accountLabel}.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate({ name: name.trim() || null });
            onOpenChange(false);
          }}
        >
          <Field>
            <FieldLabel htmlFor={fieldId}>Name</FieldLabel>
            <Input
              id={fieldId}
              value={name}
              maxLength={60}
              placeholder={account.accountLabel}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
