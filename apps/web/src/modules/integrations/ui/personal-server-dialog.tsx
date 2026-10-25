import { m } from "~/paraglide/messages.js";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { localized } from "~/i18n/localized.ts";
import { PendingButton } from "~/ui/pending-button.tsx";
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
import { Field, FieldError, FieldGroup, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { myIntegrationsQuery, personalServersQuery } from "../client/queries.ts";
import { fieldDefaults, fieldShown, fieldValues } from "../fields.ts";
import type { IntegrationField } from "../manifest.ts";
import { knownMcpServerWithUrl } from "../mcp/known-servers.ts";
import { mcpManifest } from "../mcp/manifest.ts";
import {
  PERSONAL_SERVER_FIELDS,
  type PersonalServer,
  type PersonalServers,
  type UserIntegration,
} from "../schema.ts";
import { savePersonalServer } from "../server/functions.ts";
import { DirectoryDialogContent, IntegrationDirectory } from "./integration-directory.tsx";
import { byName, integrationEntry } from "./directory-entries.ts";
import { AddByAddress } from "./add-by-address.tsx";
import { ConnectFlow } from "./connect-flow.tsx";
import { IntegrationFieldControl } from "./integration-field.tsx";
import { OAuthClientFields } from "./oauth-setup-guide.tsx";

const MCP_FIELDS: ReadonlyArray<IntegrationField> = mcpManifest.adminFields;

/**
 * The MCP setup a person fills in for their own server, worded for them. An
 * admin may offer several ways in to different people; one person picks one.
 */
const FIELDS = MCP_FIELDS.flatMap((field): IntegrationField[] => {
  if (!PERSONAL_SERVER_FIELDS.some((key) => key === field.key)) return [];
  if (field.key === "url")
    return [{ ...field, description: localized(m.integrations_server_url_description) }];
  if (field.key === "ways")
    return [
      {
        ...field,
        kind: "choice",
        label: localized(m.integrations_server_account_label),
        options: [
          {
            value: "anonymous",
            label: localized(m.integrations_server_account_none),
            description: localized(m.integrations_server_account_none_description),
          },
          {
            value: "oauth",
            label: localized(m.integrations_server_account_oauth),
            description: localized(m.integrations_server_account_oauth_description),
          },
          {
            value: "token",
            label: localized(m.integrations_server_account_token),
            description: localized(m.integrations_server_account_token_description),
          },
        ],
      },
    ];
  return [field];
});

/** One way in: a server saved before with several shows the first of them. */
const initialConfig = (stored: Readonly<Record<string, string>>) => {
  const values = fieldDefaults(FIELDS, stored);
  values.ways = fieldValues(values.ways)[0] ?? "anonymous";
  return values;
};

/** Only what is shown: a header left from a way since unticked is not sent. */
const sent = (config: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    FIELDS.filter((field) => fieldShown(field, config, FIELDS)).map((field) => [
      field.key,
      config[field.key] ?? "",
    ]),
  );

const NONE: ReadonlyArray<never> = [];

/** A known server's address and sign-in come with it, so renaming asks only the name. */
const KNOWN_KEYS = new Set(["url", "ways"]);

/** Most servers let this app register itself; the few that do not take an app of one's own. */
const OWN_APP_SETUP = {
  console: null,
  steps: [{ text: localized(m.integrations_server_own_app_step) }],
};

/**
 * Adds an integration, or edits a server of one's own. Adding starts from one
 * directory: what an admin set up, and any address for someone allowed to add
 * servers of their own. Either is connected right in the dialog.
 */
export function PersonalServerDialog({
  server,
  choices,
  shared = NONE,
  open,
  onOpenChange,
}: {
  server: PersonalServer | null;
  choices: Pick<PersonalServers, "canAdd">;
  /** Integrations an admin set up that this person has not connected. */
  shared?: ReadonlyArray<UserIntegration>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fieldId = useId();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(server?.name ?? "");
  const [config, setConfig] = useState<Record<string, string>>(() =>
    initialConfig(server?.config ?? {}),
  );
  const [clientId, setClientId] = useState(server?.oauthClientId ?? "");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A new server starts in the directory, until its address is asked for.
  const [byAddress, setByAddress] = useState(server !== null);
  // A server at a known address: its address and sign-in stay as they came.
  const known = server ? knownMcpServerWithUrl(server.config.url) : null;
  const shown = FIELDS.filter((field) => fieldShown(field, config, FIELDS));
  // An app of one's own only matters to signing in, which most known servers need none for.
  const ownApp = (!known || known.ownApp === true) && fieldValues(config.ways).includes("oauth");

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: personalServersQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: myIntegrationsQuery.queryKey }),
    ]);
  const save = useMutation({
    mutationFn: (input: { name: string; config: Record<string, string> }) =>
      savePersonalServer({
        data: {
          integrationId: server?.id ?? null,
          name: input.name.trim(),
          config: input.config,
          ...(ownApp
            ? {
                oauthClientId: clientId.trim(),
                ...(secret.trim() ? { oauthClientSecret: secret.trim() } : {}),
              }
            : {}),
        },
      }),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await refresh();
      onOpenChange(false);
    },
    onError: () => setError(m.integrations_server_save_error()),
  });
  const busy = save.isPending;
  const entries = shared
    .flatMap((integration) => integrationEntry(integration) ?? [])
    .toSorted(byName);
  // Picked from the directory: connected right here, in the same dialog.
  const [connecting, setConnecting] = useState<UserIntegration | null>(null);
  const openPage = (integrationId: string) => {
    onOpenChange(false);
    void navigate({ to: "/settings/integrations/$integrationId", params: { integrationId } });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      {connecting ? (
        <DirectoryDialogContent>
          <DialogHeader>
            <DialogTitle>
              {m.integrations_server_connect_title({ name: connecting.name })}
            </DialogTitle>
          </DialogHeader>
          <ConnectFlow
            integration={connecting}
            onBack={() => setConnecting(null)}
            onDone={() => onOpenChange(false)}
            onOpenPage={() => openPage(connecting.id)}
          />
        </DirectoryDialogContent>
      ) : !byAddress ? (
        <DirectoryDialogContent browsing={entries}>
          <DialogHeader>
            <DialogTitle>{m.integrations_settings_add()}</DialogTitle>
          </DialogHeader>
          <IntegrationDirectory
            entries={entries}
            custom={
              choices.canAdd
                ? {
                    label: m.integrations_server_by_address(),
                    onPick: () => setByAddress(true),
                  }
                : null
            }
            onPick={(entry) =>
              setConnecting(
                shared.find((integration) => integration.id === entry.integrationId) ?? null,
              )
            }
          />
        </DirectoryDialogContent>
      ) : !server ? (
        // A new server keeps the directory’s width, so its steps read as the same dialog.
        <DirectoryDialogContent>
          <DialogHeader>
            <DialogTitle>{m.integrations_server_add_title()}</DialogTitle>
          </DialogHeader>
          <AddByAddress
            onBack={() => setByAddress(false)}
            onDone={() => onOpenChange(false)}
            onOpenPage={openPage}
          />
        </DirectoryDialogContent>
      ) : (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {known && !known.ownApp
                ? m.integrations_server_rename_title({ name: server.name })
                : m.integrations_server_setup_title({ name: server.name })}
            </DialogTitle>
            <DialogDescription>{m.integrations_server_dialog_description()}</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-6"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              save.mutate({ name, config: sent(config) });
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${fieldId}-name`}>{m.common_name()}</FieldLabel>
                <Input
                  id={`${fieldId}-name`}
                  value={name}
                  maxLength={60}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                />
              </Field>
              {shown
                .filter((field) => !(known && KNOWN_KEYS.has(field.key)))
                .map((field) => (
                  <IntegrationFieldControl
                    key={field.key}
                    id={`${fieldId}-${field.key}`}
                    field={field}
                    value={config[field.key] ?? ""}
                    onChange={(value) =>
                      setConfig((current) => ({ ...current, [field.key]: value }))
                    }
                    disabled={busy}
                  />
                ))}
              {ownApp ? (
                <OAuthClientFields
                  id={fieldId}
                  setup={OWN_APP_SETUP}
                  redirectUri={
                    server.redirectUri ??
                    `${window.location.origin}/api/integrations/${server.id}/callback`
                  }
                  config={config}
                  clientId={clientId}
                  onClientIdChange={setClientId}
                  secret={secret}
                  onSecretChange={setSecret}
                  secretStored={Boolean(server.oauthClientId && server.oauthSecretConfigured)}
                  disabled={busy}
                />
              ) : null}
            </FieldGroup>
            {error ? <FieldError>{error}</FieldError> : null}
            <DialogFooter>
              <DialogClose render={<Button variant="outline" disabled={busy} />}>
                {m.common_cancel()}
              </DialogClose>
              <PendingButton type="submit" pending={save.isPending} disabled={!name.trim()}>
                {m.common_save()}
              </PendingButton>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}
