import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { OptionalMark } from "~/ui/form/form-fields.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Switch } from "~/ui/primitives/switch";
import { findIntegrationType } from "../catalog.ts";
import { integrationLook } from "../client/directory.ts";
import { adminIntegrationsQuery } from "../client/queries.ts";
import { fieldDefaults, fieldShown } from "../fields.ts";
import type { IntegrationField } from "../manifest.ts";
import type { AdminIntegration } from "../schema.ts";
import { saveIntegrationConfig } from "../server/functions.ts";
import { IntegrationFieldControl } from "./integration-field.tsx";
import { OAuthClientFields } from "./oauth-setup-guide.tsx";
import { findKnownMcpServer } from "../mcp/known-servers.ts";

export type AdminRow = AdminIntegration & { redirectUri: string | null };

/** An integration's settings, edited from its page. Leaves it on or off as it is. */
export function IntegrationConfigDialog({
  row,
  open,
  onOpenChange,
}: {
  row: AdminRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {row.name}</DialogTitle>
          <DialogDescription>
            Secrets are encrypted at rest and never shown again. People connect their own accounts
            from Settings.
          </DialogDescription>
        </DialogHeader>
        <IntegrationSettingsForm
          row={row}
          enable={row.enabled}
          submitLabel="Save"
          onPendingChange={setBusy}
          onSaved={() => onOpenChange(false)}
          cancelLabel="Cancel"
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * An integration's settings, as its type's manifest declares them: name and
 * description, address, the admin's own app, a shared key, personal keys.
 * Adding saves them and turns it on in one step; editing keeps it as it was.
 */
export function IntegrationSettingsForm({
  row,
  enable,
  submitLabel,
  onSaved,
  onPendingChange,
  cancelLabel,
  onCancel,
}: {
  row: AdminRow;
  /** Saved as on or off; the server refuses on until people have a way in. */
  enable: boolean;
  submitLabel: string;
  onSaved: () => void;
  onPendingChange?: (pending: boolean) => void;
  /** The footer button beside submit: Cancel when editing, Back when adding. */
  cancelLabel: string;
  onCancel: () => void;
}) {
  const fieldId = useId();
  const queryClient = useQueryClient();
  const manifest = findIntegrationType(row.kind)!;
  const [name, setName] = useState(row.name);
  const [description, setDescription] = useState(row.description ?? "");
  // What shows when the admin writes nothing: the known server's words, else the type's.
  const ownDescription = integrationLook({ kind: row.kind, server: row.server })!.description;
  const [config, setConfig] = useState<Record<string, string>>(() =>
    fieldDefaults(manifest.adminFields, row.config),
  );
  const [shared, setShared] = useState<Record<string, string>>({});
  const fields = manifest.adminFields;
  const shownFields = fields.filter((field) => fieldShown(field, config, fields));
  const showOAuth = Boolean(manifest.oauth && fieldShown(manifest.oauth, config, fields));
  const showSharedKey = Boolean(
    manifest.sharedCredential && fieldShown(manifest.sharedCredential, config, fields),
  );
  // A known server that lets in only registered apps needs the admin's, so it is not optional.
  const appRequired = Boolean(findKnownMcpServer(row.server)?.ownApp);
  const optionalClient = Boolean(manifest.oauth?.optionalClient) && !appRequired;
  // Signing in through the admin's app and personal keys are two ways in, at least one needed:
  // asked as a choice, so the app's fields read as required once it is picked.
  const choosesWays = Boolean(
    manifest.oauth &&
    !manifest.oauth.when &&
    !optionalClient &&
    manifest.apiKey &&
    !manifest.apiKey.when,
  );
  const [ownClient, setOwnClient] = useState(
    choosesWays || optionalClient ? Boolean(row.oauthClientId) : true,
  );
  const [clientId, setClientId] = useState(row.oauthClientId ?? "");
  const [secret, setSecret] = useState("");
  const [allowApiKeys, setAllowApiKeys] = useState(row.allowApiKeys);
  const [error, setError] = useState<string | null>(null);
  const noWay = choosesWays && !ownClient && !allowApiKeys;
  const ways: IntegrationField = {
    key: "ways",
    label: "How people connect",
    kind: "choices",
    required: true,
    ...(noWay ? { description: "Pick at least one." } : {}),
    options: [
      {
        value: "oauth",
        label: "Sign in",
        description: `Through an OAuth app you register with ${manifest.name}.`,
      },
      {
        value: "keys",
        label: "Personal API keys",
        description: `People paste a key from their own ${manifest.name} account.`,
      },
    ],
  };
  const redirectUri =
    row.redirectUri ?? `${window.location.origin}/api/integrations/${row.id}/callback`;

  const save = useMutation({
    mutationFn: () =>
      saveIntegrationConfig({
        data: {
          integrationId: row.id,
          name: name.trim(),
          description,
          enabled: enable,
          config,
          // Switching the admin's own client off forgets it, secret included.
          ...(ownClient
            ? {
                oauthClientId: clientId.trim(),
                ...(secret.trim() ? { oauthClientSecret: secret.trim() } : {}),
              }
            : { oauthClientId: "", oauthClientSecret: "" }),
          allowApiKeys,
          // Only what was typed: an untouched shared key stays as stored.
          ...(showSharedKey && Object.values(shared).some((value) => value.trim())
            ? { sharedCredential: shared }
            : {}),
        },
      }),
    onMutate: () => onPendingChange?.(true),
    onSettled: () => onPendingChange?.(false),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: adminIntegrationsQuery.queryKey });
      onSaved();
    },
    onError: () => setError("Could not save the integration."),
  });
  const fieldControl = (field: IntegrationField) => (
    <IntegrationFieldControl
      key={field.key}
      id={`${fieldId}-${field.key}`}
      field={field}
      value={config[field.key] ?? ""}
      onChange={(value) => setConfig((current) => ({ ...current, [field.key]: value }))}
      disabled={save.isPending}
    />
  );
  const oauthFields = manifest.oauth ? (
    <OAuthClientFields
      id={fieldId}
      setup={manifest.oauth.setup}
      redirectUri={redirectUri}
      config={config}
      clientId={clientId}
      onClientIdChange={setClientId}
      secret={secret}
      onSecretChange={setSecret}
      secretStored={Boolean(row.oauthClientId && row.oauthSecretConfigured)}
      // A server's own sign-in may take a public client; a service's needs both halves.
      optional={optionalClient}
      secretRequired={row.kind !== "mcp"}
      disabled={save.isPending}
    />
  ) : null;

  return (
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
          <FieldDescription>Shown in chats and @mentions.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${fieldId}-description`}>
            Description <OptionalMark />
          </FieldLabel>
          <Input
            id={`${fieldId}-description`}
            value={description}
            maxLength={160}
            placeholder={ownDescription}
            onChange={(event) => setDescription(event.target.value)}
            disabled={save.isPending}
          />
          <FieldDescription>What people see when they choose what to connect.</FieldDescription>
        </Field>
        {shownFields.map(fieldControl)}
        {showSharedKey && manifest.sharedCredential
          ? manifest.sharedCredential.fields.map((field) => (
              <IntegrationFieldControl
                key={`shared-${field.key}`}
                id={`${fieldId}-shared-${field.key}`}
                field={{
                  ...field,
                  ...(row.sharedCredentialConfigured ? { placeholder: "Unchanged" } : {}),
                }}
                value={shared[field.key] ?? ""}
                onChange={(value) => setShared((current) => ({ ...current, [field.key]: value }))}
                disabled={save.isPending}
              >
                <FieldDescription>
                  Everyone uses it, so chats only ever read with it.
                </FieldDescription>
              </IntegrationFieldControl>
            ))
          : null}
        {showOAuth && optionalClient ? (
          <Field>
            <div className="flex items-center justify-between gap-3">
              <FieldLabel htmlFor={`${fieldId}-own-client`}>Registered app</FieldLabel>
              <Switch
                id={`${fieldId}-own-client`}
                checked={ownClient}
                onCheckedChange={setOwnClient}
                disabled={save.isPending}
              />
            </div>
            <FieldDescription>
              For a sign-in that only accepts apps registered with it.
            </FieldDescription>
          </Field>
        ) : null}
        {choosesWays ? (
          <IntegrationFieldControl
            id={`${fieldId}-ways`}
            field={ways}
            value={[ownClient ? "oauth" : "", allowApiKeys ? "keys" : ""].join(" ").trim()}
            onChange={(value) => {
              const picked = value.split(" ");
              setOwnClient(picked.includes("oauth"));
              setAllowApiKeys(picked.includes("keys"));
            }}
            disabled={save.isPending}
          />
        ) : null}
        {showOAuth && ownClient ? oauthFields : null}
        {manifest.apiKey && !manifest.apiKey.when && !choosesWays ? (
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
              People can paste a key from their own {manifest.name} account instead of signing in.
            </FieldDescription>
          </Field>
        ) : null}
      </FieldGroup>
      {error ? <FieldError>{error}</FieldError> : null}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <PendingButton type="submit" pending={save.isPending} disabled={enable && noWay}>
          {submitLabel}
        </PendingButton>
      </DialogFooter>
    </form>
  );
}
