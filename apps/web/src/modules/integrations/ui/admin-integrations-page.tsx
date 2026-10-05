import { PencilEdit02Icon, UserMultipleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { AccessDialog } from "~/modules/sharing/ui/access-dialog.tsx";
import { OptionalMark } from "~/ui/form/form-fields.tsx";
import { ListCard, ListRow, Page } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Switch } from "~/ui/primitives/switch";
import { findIntegration } from "../catalog.ts";
import { adminIntegrationsQuery } from "../client/queries.ts";
import type { AdminIntegration } from "../schema.ts";
import { saveIntegrationConfig } from "../server/functions.ts";
import { IntegrationLogo } from "./integration-logo.tsx";

type AdminRow = AdminIntegration & { redirectUri: string | null };

export function AdminIntegrationsPage() {
  const { data } = useSuspenseQuery(adminIntegrationsQuery);
  const [editing, setEditing] = useState<string | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const current = data.integrations.find((row) => row.id === editing) ?? null;

  return (
    <Page
      title="Integrations"
      description="Services people can connect their own accounts to, for chat tools and knowledge sync."
    >
      <ListCard>
        {data.integrations.map((row) => {
          const manifest = findIntegration(row.id);
          if (!manifest) return null;
          return (
            <ListRow key={row.id}>
              <IntegrationLogo integrationId={row.id} variant="tile" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {manifest.name}
                  {row.enabled ? (
                    <Badge variant="secondary">On</Badge>
                  ) : (
                    <Badge variant="outline">Off</Badge>
                  )}
                </span>
                <span className="text-muted-foreground truncate text-xs">
                  {row.connectionCount === 1
                    ? "1 person connected"
                    : `${row.connectionCount} people connected`}
                </span>
              </div>
              {row.saved ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Who can use ${manifest.name}`}
                  onClick={() => setSharing(row.id)}
                >
                  <HugeiconsIcon icon={UserMultipleIcon} strokeWidth={2} />
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Set up ${manifest.name}`}
                onClick={() => setEditing(row.id)}
              >
                <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
              </Button>
            </ListRow>
          );
        })}
      </ListCard>
      {current ? (
        <IntegrationConfigDialog
          key={current.id}
          row={current}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      ) : null}
      {sharing ? (
        <AccessDialog
          resource={{ kind: "integration", id: sharing }}
          title={findIntegration(sharing)?.name ?? sharing}
          open
          onOpenChange={(open) => !open && setSharing(null)}
        />
      ) : null}
    </Page>
  );
}

function IntegrationConfigDialog({
  row,
  open,
  onOpenChange,
}: {
  row: AdminRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fieldId = useId();
  const queryClient = useQueryClient();
  const manifest = findIntegration(row.id)!;
  const [config, setConfig] = useState<Record<string, string>>(() => ({ ...row.config }));
  const [enabled, setEnabled] = useState(row.enabled);
  const [clientId, setClientId] = useState(row.oauthClientId ?? "");
  const [secret, setSecret] = useState("");
  const [allowApiKeys, setAllowApiKeys] = useState(row.allowApiKeys);
  const [error, setError] = useState<string | null>(null);
  const redirectUri =
    row.redirectUri ?? `${window.location.origin}/api/integrations/${row.id}/callback`;

  const save = useMutation({
    mutationFn: () =>
      saveIntegrationConfig({
        data: {
          integrationId: row.id,
          enabled,
          config,
          oauthClientId: clientId.trim(),
          ...(secret.trim() ? { oauthClientSecret: secret.trim() } : {}),
          allowApiKeys,
        },
      }),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: adminIntegrationsQuery.queryKey });
      onOpenChange(false);
    },
    onError: () => setError("Could not save the integration."),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && save.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set up {manifest.name}</DialogTitle>
          <DialogDescription>
            Secrets are encrypted at rest and never shown again. People connect their own accounts
            from Settings.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            save.mutate();
          }}
        >
          <FieldGroup>
            <Field>
              <div className="flex items-center justify-between gap-3">
                <FieldLabel htmlFor={`${fieldId}-enabled`}>Enabled</FieldLabel>
                <Switch
                  id={`${fieldId}-enabled`}
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  disabled={save.isPending}
                />
              </div>
              <FieldDescription>
                Turning it off stops chat tools and syncing; connections are kept.
              </FieldDescription>
            </Field>
            {manifest.adminFields.map((field) => (
              <Field key={field.key}>
                <FieldLabel htmlFor={`${fieldId}-${field.key}`}>
                  {field.label} {field.required ? null : <OptionalMark />}
                </FieldLabel>
                <Input
                  id={`${fieldId}-${field.key}`}
                  type={field.kind === "url" ? "url" : "text"}
                  value={config[field.key] ?? ""}
                  placeholder={field.placeholder}
                  onChange={(event) =>
                    setConfig((current) => ({ ...current, [field.key]: event.target.value }))
                  }
                  disabled={save.isPending}
                />
                {field.description ? (
                  <FieldDescription>{field.description}</FieldDescription>
                ) : null}
              </Field>
            ))}
            {manifest.oauth ? (
              <>
                <Field>
                  <FieldLabel htmlFor={`${fieldId}-redirect`}>Redirect URI</FieldLabel>
                  <Input id={`${fieldId}-redirect`} readOnly value={redirectUri} />
                  <FieldDescription>{manifest.oauth.setup}</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${fieldId}-client`}>
                    OAuth client ID <OptionalMark />
                  </FieldLabel>
                  <Input
                    id={`${fieldId}-client`}
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value)}
                    disabled={save.isPending}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${fieldId}-secret`}>
                    OAuth client secret <OptionalMark />
                  </FieldLabel>
                  <Input
                    id={`${fieldId}-secret`}
                    type="password"
                    autoComplete="off"
                    placeholder={row.oauthSecretConfigured ? "Unchanged" : undefined}
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    disabled={save.isPending}
                  />
                  {row.oauthSecretConfigured ? (
                    <FieldDescription>Leave empty to keep the stored secret.</FieldDescription>
                  ) : null}
                </Field>
              </>
            ) : null}
            {manifest.apiKey ? (
              <Field>
                <div className="flex items-center justify-between gap-3">
                  <FieldLabel htmlFor={`${fieldId}-keys`}>Allow personal API keys</FieldLabel>
                  <Switch
                    id={`${fieldId}-keys`}
                    checked={allowApiKeys}
                    onCheckedChange={setAllowApiKeys}
                    disabled={save.isPending}
                  />
                </div>
                <FieldDescription>
                  People can paste a key from their own {manifest.name} account instead of signing
                  in.
                </FieldDescription>
              </Field>
            ) : null}
          </FieldGroup>
          {error ? <FieldError>{error}</FieldError> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
              Cancel
            </DialogClose>
            <PendingButton type="submit" pending={save.isPending}>
              Save
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
