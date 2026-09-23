import { PlugSocketIcon } from "@hugeicons/core-free-icons";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useId } from "react";
import type { ToolPermission } from "../consent.ts";
import { useConfirm } from "~/ui/confirm.tsx";
import { toastError } from "~/ui/error-toast.ts";
import { EmptyState, ListCard, ListRow, Page } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Field, FieldDescription, FieldLabel } from "~/ui/primitives/field";
import { Switch } from "~/ui/primitives/switch";
import { findIntegration } from "../catalog.ts";
import { myIntegrationsQuery } from "../client/queries.ts";
import type { UserIntegration } from "../schema.ts";
import { disconnectIntegration, updateIntegrationConnection } from "../server/functions.ts";
import { ConnectActions } from "./connect-actions.tsx";
import { IntegrationLogo } from "./integration-logo.tsx";
import { ToolPermissions } from "./tool-permissions.tsx";

export function IntegrationsSettingsPage() {
  const { data } = useSuspenseQuery(myIntegrationsQuery);
  return (
    <Page
      title="Integrations"
      description="Connect your own accounts so chats can search, read and, with your approval, change things there."
      rootPath="/settings"
      rootLabel="Settings"
    >
      {data.length === 0 ? (
        <EmptyState
          icon={PlugSocketIcon}
          title="No integrations yet"
          description="An admin turns integrations on for this instance. Once they do, you can connect your account here."
        />
      ) : (
        <ListCard>
          {data.map((integration) => (
            <IntegrationRow key={integration.id} integration={integration} />
          ))}
        </ListCard>
      )}
    </Page>
  );
}

function IntegrationRow({ integration }: { integration: UserIntegration }) {
  const manifest = findIntegration(integration.id);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const fieldId = useId();
  const refresh = () => queryClient.invalidateQueries({ queryKey: myIntegrationsQuery.queryKey });

  const update = useMutation({
    mutationFn: (input: {
      offerByDefault?: boolean;
      toolPermissions?: Record<string, ToolPermission>;
    }) => updateIntegrationConnection({ data: { integrationId: integration.id, ...input } }),
    onSuccess: refresh,
    onError: (error) => toastError("Could not save that preference.", error),
  });
  const disconnect = useMutation({
    mutationFn: () => disconnectIntegration({ data: { integrationId: integration.id } }),
    onSuccess: refresh,
    onError: (error) => toastError("Could not disconnect.", error),
  });

  if (!manifest) return null;
  const { connection } = integration;
  const needsReauth = connection?.status === "needs_reauth";
  const dependents = [
    integration.dependents.sources === 1
      ? "1 knowledge source"
      : integration.dependents.sources > 1
        ? `${integration.dependents.sources} knowledge sources`
        : null,
    integration.dependents.schedules === 1
      ? "1 schedule"
      : integration.dependents.schedules > 1
        ? `${integration.dependents.schedules} schedules`
        : null,
  ].filter(Boolean);

  return (
    <ListRow className="flex-col items-stretch gap-3">
      <div className="flex items-center gap-3">
        <IntegrationLogo integrationId={integration.id} variant="tile" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2 text-sm font-medium">
            {manifest.name}
            {needsReauth ? <Badge variant="destructive">Reconnect</Badge> : null}
            {!integration.available && connection ? (
              <Badge variant="outline">Turned off</Badge>
            ) : null}
          </span>
          <span className="text-muted-foreground truncate text-xs">
            {connection ? connection.accountLabel : manifest.description}
          </span>
        </div>
        {integration.available && (!connection || needsReauth) ? (
          <ConnectActions integration={integration} />
        ) : null}
        {connection ? (
          <PendingButton
            size="sm"
            variant="ghost"
            pending={disconnect.isPending}
            onClick={async () => {
              if (
                await confirm({
                  title: `Disconnect ${manifest.name}?`,
                  description: dependents.length
                    ? `Chats lose its tools, and ${dependents.join(" and ")} stop working until you connect again. Documents already synced stay.`
                    : "Chats lose its tools until you connect again.",
                  confirmLabel: "Disconnect",
                })
              )
                disconnect.mutate();
            }}
          >
            Disconnect
          </PendingButton>
        ) : null}
      </div>
      {connection && integration.available && !needsReauth ? (
        <div className="flex flex-col gap-3 pl-12">
          <Field>
            <div className="flex items-center justify-between gap-3">
              <FieldLabel htmlFor={`${fieldId}-offer`}>Offer in chats</FieldLabel>
              <Switch
                id={`${fieldId}-offer`}
                checked={connection.offerByDefault}
                disabled={update.isPending}
                onCheckedChange={(offerByDefault) => update.mutate({ offerByDefault })}
              />
            </div>
            <FieldDescription>
              On for every new chat. Any chat can still turn it on or off, or mention it with @
              {manifest.id}.
            </FieldDescription>
          </Field>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Tool permissions</p>
            <p className="text-muted-foreground mb-2 text-xs">
              Choose when chats may use each tool. Blocked tools are never offered.
            </p>
            <ToolPermissions
              integrationId={integration.id}
              permissions={connection.toolPermissions}
              disabled={update.isPending}
              onChange={(toolPermissions) => update.mutate({ toolPermissions })}
            />
          </div>
        </div>
      ) : null}
    </ListRow>
  );
}
