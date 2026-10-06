import {
  Add01Icon,
  PencilEdit02Icon,
  PlugSocketIcon,
  UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { AccessDialog } from "~/modules/sharing/ui/access-dialog.tsx";
import { OptionalMark } from "~/ui/form/form-fields.tsx";
import { useConfirm } from "~/ui/confirm-context.ts";
import { EmptyState, ListCard, ListRow, Page } from "~/ui/page-shell.tsx";
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
import { RadioGroup, RadioGroupItem } from "~/ui/primitives/radio-group";
import { Switch } from "~/ui/primitives/switch";
import { findIntegrationType, INTEGRATION_TYPES } from "../catalog.ts";
import { adminIntegrationsQuery } from "../client/queries.ts";
import type { AdminIntegration } from "../schema.ts";
import {
  createIntegration,
  deleteIntegration,
  saveIntegrationConfig,
} from "../server/functions.ts";
import { IntegrationFieldControl } from "./integration-field.tsx";
import { IntegrationLogo } from "./integration-logo.tsx";
import { OAuthSetupGuide } from "./oauth-setup-guide.tsx";

type AdminRow = AdminIntegration & { redirectUri: string | null };

export function AdminIntegrationsPage() {
  const { data } = useSuspenseQuery(adminIntegrationsQuery);
  const [editing, setEditing] = useState<string | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const current = data.integrations.find((row) => row.id === editing) ?? null;
  const shared = data.integrations.find((row) => row.id === sharing) ?? null;
  const add = (
    <Button size="sm" onClick={() => setAdding(true)}>
      <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
      Add integration
    </Button>
  );

  return (
    <Page
      title="Integrations"
      description="Services people can connect their own accounts to, for chat tools and knowledge sync."
      actions={data.integrations.length ? add : null}
    >
      {data.integrations.length === 0 ? (
        <EmptyState
          icon={PlugSocketIcon}
          title="No integrations yet"
          description="Add one to let people connect their own accounts."
          action={add}
        />
      ) : (
        <ListCard>
          {data.integrations.map((row) => {
            const type = findIntegrationType(row.kind);
            if (!type) return null;
            const people =
              row.connectionCount === 1
                ? "1 person connected"
                : `${row.connectionCount} people connected`;
            return (
              <ListRow key={row.id}>
                <IntegrationLogo integrationId={row.id} variant="tile" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {row.name}
                    {row.enabled ? (
                      <Badge variant="secondary">On</Badge>
                    ) : (
                      <Badge variant="outline">Off</Badge>
                    )}
                  </span>
                  <span className="text-muted-foreground truncate text-xs">
                    {/* The type only when the name does not already say it. */}
                    {row.name === type.name ? people : `${type.name} · ${people}`}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Who can use ${row.name}`}
                  onClick={() => setSharing(row.id)}
                >
                  <HugeiconsIcon icon={UserMultipleIcon} strokeWidth={2} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Set up ${row.name}`}
                  onClick={() => setEditing(row.id)}
                >
                  <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                </Button>
              </ListRow>
            );
          })}
        </ListCard>
      )}
      {current ? (
        <IntegrationConfigDialog
          key={current.id}
          row={current}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      ) : null}
      {shared ? (
        <AccessDialog
          resource={{ kind: "integration", id: shared.id }}
          title={shared.name}
          open
          onOpenChange={(open) => !open && setSharing(null)}
        />
      ) : null}
      {adding ? (
        <AddIntegrationDialog
          takenNames={data.integrations.map((row) => row.name)}
          onOpenChange={setAdding}
          onCreated={(id) => {
            setAdding(false);
            setEditing(id);
          }}
        />
      ) : null}
    </Page>
  );
}

/** A name not in use yet: the type's own, else numbered. */
const freeName = (base: string, taken: ReadonlyArray<string>) => {
  const used = new Set(taken.map((name) => name.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  let n = 2;
  while (used.has(`${base} ${n}`.toLowerCase())) n++;
  return `${base} ${n}`;
};

function AddIntegrationDialog({
  takenNames,
  onOpenChange,
  onCreated,
}: {
  takenNames: ReadonlyArray<string>;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const fieldId = useId();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState(INTEGRATION_TYPES[0]!.kind);
  const [name, setName] = useState(() => freeName(INTEGRATION_TYPES[0]!.name, takenNames));
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => createIntegration({ data: { kind, name: name.trim() } }),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: adminIntegrationsQuery.queryKey });
      onCreated(result.id);
    },
    onError: () => setError("Could not add the integration."),
  });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && create.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add integration</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            create.mutate();
          }}
        >
          <FieldGroup>
            <ListCard>
              <RadioGroup
                variant="list"
                value={kind}
                aria-label="Service"
                onValueChange={(value) => {
                  const type = findIntegrationType(String(value));
                  if (!type) return;
                  setKind(type.kind);
                  setName(freeName(type.name, takenNames));
                }}
              >
                {INTEGRATION_TYPES.map((type) => (
                  <label
                    key={type.kind}
                    htmlFor={`${fieldId}-${type.kind}`}
                    className="hover:bg-accent/50 flex cursor-pointer items-center gap-3 px-4 py-3 text-sm font-medium transition-colors"
                  >
                    <RadioGroupItem
                      id={`${fieldId}-${type.kind}`}
                      value={type.kind}
                      aria-labelledby={`${fieldId}-${type.kind}-name`}
                    />
                    <type.logo className="size-4 shrink-0" />
                    <span id={`${fieldId}-${type.kind}-name`}>{type.name}</span>
                  </label>
                ))}
              </RadioGroup>
            </ListCard>
            <Field>
              <FieldLabel htmlFor={`${fieldId}-name`}>Name</FieldLabel>
              <Input
                id={`${fieldId}-name`}
                value={name}
                maxLength={60}
                onChange={(event) => setName(event.target.value)}
                disabled={create.isPending}
              />
              <FieldDescription>Shown in chats and @mentions.</FieldDescription>
            </Field>
          </FieldGroup>
          {error ? <FieldError>{error}</FieldError> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={create.isPending} />}>
              Cancel
            </DialogClose>
            <PendingButton
              type="submit"
              pending={create.isPending}
              disabled={!name.trim()}
            >
              Add
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
  const manifest = findIntegrationType(row.kind)!;
  const confirm = useConfirm();
  const [name, setName] = useState(row.name);
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
          name: name.trim(),
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
  const remove = useMutation({
    mutationFn: () => deleteIntegration({ data: { integrationId: row.id } }),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: adminIntegrationsQuery.queryKey });
      onOpenChange(false);
    },
    onError: () => setError("Could not delete the integration."),
  });
  const confirmRemove = async () => {
    const people = row.connectionCount;
    if (
      await confirm({
        title: `Delete ${row.name}?`,
        description: `${people ? `${people === 1 ? "1 person loses their connection" : `${people} people lose their connections`}, and ` : ""}chats, agents and schedules stop using it. Past answers keep what it found.`,
        confirmLabel: "Delete",
      })
    )
      remove.mutate();
  };

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
          <DialogTitle>Set up {row.name}</DialogTitle>
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
              <FieldLabel htmlFor={`${fieldId}-name`}>Name</FieldLabel>
              <Input
                id={`${fieldId}-name`}
                value={name}
                maxLength={60}
                onChange={(event) => setName(event.target.value)}
                disabled={save.isPending}
              />
            </Field>
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
              <IntegrationFieldControl
                key={field.key}
                id={`${fieldId}-${field.key}`}
                field={field}
                value={config[field.key] ?? ""}
                onChange={(value) => setConfig((current) => ({ ...current, [field.key]: value }))}
                disabled={save.isPending}
              />
            ))}
            {manifest.oauth ? (
              <>
                <OAuthSetupGuide
                  id={`${fieldId}-redirect`}
                  setup={manifest.oauth.setup}
                  redirectUri={redirectUri}
                  config={config}
                  configured={Boolean(row.oauthClientId && row.oauthSecretConfigured)}
                />
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
            <PendingButton
              type="button"
              variant="destructive"
              className="mr-auto"
              pending={remove.isPending}
              disabled={save.isPending}
              onClick={() => void confirmRemove()}
            >
              Delete
            </PendingButton>
            <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
              Cancel
            </DialogClose>
            <PendingButton type="submit" pending={save.isPending} disabled={remove.isPending}>
              Save
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
