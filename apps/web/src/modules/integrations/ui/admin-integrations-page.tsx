import { m } from "~/paraglide/messages.js";
import { Add01Icon, ArrowRight01Icon, PlugSocketIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { EmptyState, ListCard, ListRow, Page } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Field, FieldDescription, FieldError, FieldGroup } from "~/ui/primitives/field";
import { integrationLook } from "../client/directory.ts";
import { adminIntegrationsQuery } from "../client/queries.ts";
import { mcpManifest } from "../mcp/manifest.ts";
import { createIntegration, deleteIntegration } from "../server/functions.ts";
import {
  byName,
  freeName,
  SERVER_ENTRIES,
  TYPE_ENTRIES,
  type DirectoryEntry,
} from "./directory-entries.ts";
import {
  DirectoryDialogContent,
  DirectoryEntryHeader,
  IntegrationDirectory,
} from "./integration-directory.tsx";
import { IntegrationLogo } from "./integration-logo.tsx";
import { IntegrationSettingsForm } from "./integration-config-dialog.tsx";
import { findKnownMcpServer } from "../mcp/known-servers.ts";

export function AdminIntegrationsPage() {
  const { data } = useSuspenseQuery(adminIntegrationsQuery);
  const [adding, setAdding] = useState(false);
  const add = (
    <Button size="sm" onClick={() => setAdding(true)}>
      <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
      {m.integrations_settings_add()}
    </Button>
  );

  return (
    <Page
      title={m.integrations_admin_title()}
      description={m.integrations_admin_description()}
      actions={data.integrations.length ? add : null}
    >
      {data.integrations.length === 0 ? (
        <EmptyState
          icon={PlugSocketIcon}
          title={m.integrations_admin_empty_title()}
          description={m.integrations_admin_empty_description()}
          action={add}
        />
      ) : (
        <ListCard>
          {data.integrations.map((row) => {
            const look = integrationLook(row);
            if (!look) return null;
            const people = m.integrations_admin_people_connected({ count: row.connectionCount });
            return (
              <Link
                key={row.id}
                to="/admin/integrations/$integrationId"
                params={{ integrationId: row.id }}
                className="block"
              >
                <ListRow interactive>
                  <IntegrationLogo integrationId={row.id} variant="tile" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {row.name}
                      {row.enabled ? null : (
                        <Badge variant="outline">{m.integrations_admin_off()}</Badge>
                      )}
                    </span>
                    <span className="text-muted-foreground truncate text-xs">
                      {/* The type only when the name does not already say it. */}
                      {row.name === look.name ? people : `${look.name} · ${people}`}
                    </span>
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
      {adding ? (
        <AddIntegrationDialog
          takenNames={data.integrations.map((row) => row.name)}
          added={data.integrations.flatMap((row) => (row.server ? [row.server] : []))}
          onOpenChange={setAdding}
        />
      ) : null}
    </Page>
  );
}

/** Any MCP server by its address, the directory's last tile. */
const customServer = (): DirectoryEntry => ({
  key: "mcp",
  kind: "mcp",
  server: null,
  integrationId: null,
  name: m.integrations_admin_custom_server(),
  description: mcpManifest.description,
  category: null,
  logo: mcpManifest.logo,
});

/**
 * One directory of everything an admin can offer. A known server is added as
 * it is, on and ready for people to connect. Anything else is set up in the
 * same dialog and turned on by saving it. It exists from the moment it is
 * picked, since its redirect URI names it, so going back deletes it.
 */
function AddIntegrationDialog({
  takenNames,
  added,
  onOpenChange,
}: {
  takenNames: ReadonlyArray<string>;
  /** Known servers added already, so not offered again. */
  added: ReadonlyArray<string>;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data } = useSuspenseQuery(adminIntegrationsQuery);
  // A known server that needs nothing more waits for a confirming click.
  const [confirming, setConfirming] = useState<DirectoryEntry | null>(null);
  // Created and waiting for its settings.
  const [settingUp, setSettingUp] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: adminIntegrationsQuery.queryKey });
  const open = (integrationId: string) => {
    onOpenChange(false);
    void navigate({ to: "/admin/integrations/$integrationId", params: { integrationId } });
  };
  const create = useMutation({
    mutationFn: (entry: DirectoryEntry) =>
      createIntegration({
        data: {
          kind: entry.kind,
          name: freeName(entry.name, takenNames),
          ...(entry.server ? { server: entry.server } : {}),
        },
      }),
    onSuccess: async (result, entry) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await refresh();
      if (readyAsAdded(entry)) open(result.id);
      else setSettingUp(result.id);
    },
    onError: () => setError(m.integrations_admin_add_error()),
  });
  // Never turned on: nothing of it stays behind.
  const discard = () => {
    if (settingUp)
      void deleteIntegration({ data: { integrationId: settingUp } }).then(refresh, refresh);
    setSettingUp(null);
    setError(null);
  };
  const pick = (entry: DirectoryEntry) => {
    // One created before whose row never arrived is not left behind by the next.
    discard();
    if (readyAsAdded(entry)) setConfirming(entry);
    else create.mutate(entry);
  };
  const entries = [
    ...TYPE_ENTRIES,
    ...SERVER_ENTRIES.filter((entry) => entry.server && !added.includes(entry.server)),
  ].toSorted(byName);
  const row = settingUp ? data.integrations.find((entry) => entry.id === settingUp) : undefined;
  const pending = create.isPending || busy;

  return (
    <Dialog
      open
      // A stray click beside a half-filled form would delete it; Close and Escape still do.
      disablePointerDismissal={settingUp !== null}
      onOpenChange={(next) => {
        if (!next && pending) return;
        if (!next) discard();
        onOpenChange(next);
      }}
    >
      {row ? (
        <DirectoryDialogContent>
          <DialogHeader>
            <DialogTitle>{m.integrations_admin_setup_title({ name: row.name })}</DialogTitle>
            <DialogDescription>{m.integrations_admin_secrets_description()}</DialogDescription>
          </DialogHeader>
          <IntegrationSettingsForm
            row={row}
            enable
            submitLabel={m.integrations_admin_turn_on()}
            onPendingChange={setBusy}
            onSaved={() => {
              setSettingUp(null);
              open(row.id);
            }}
            cancelLabel={m.common_back()}
            onCancel={discard}
          />
        </DirectoryDialogContent>
      ) : confirming ? (
        <DirectoryDialogContent>
          <DialogHeader>
            <DialogTitle>{m.integrations_admin_add_title({ name: confirming.name })}</DialogTitle>
          </DialogHeader>
          <form
            className="flex flex-col gap-6"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              create.mutate(confirming);
            }}
          >
            <FieldGroup>
              <Field>
                <DirectoryEntryHeader entry={confirming} />
                <FieldDescription>{m.integrations_admin_add_ready()}</FieldDescription>
              </Field>
            </FieldGroup>
            {error ? <FieldError>{error}</FieldError> : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={create.isPending}
                onClick={() => setConfirming(null)}
              >
                {m.common_back()}
              </Button>
              <PendingButton type="submit" pending={create.isPending}>
                {m.common_add()}
              </PendingButton>
            </DialogFooter>
          </form>
        </DirectoryDialogContent>
      ) : (
        <DirectoryDialogContent browsing={entries}>
          <DialogHeader>
            <DialogTitle>{m.integrations_settings_add()}</DialogTitle>
            {create.isPending ? (
              <DialogDescription>{m.integrations_admin_adding()}</DialogDescription>
            ) : error ? (
              <DialogDescription className="text-destructive">{error}</DialogDescription>
            ) : null}
          </DialogHeader>
          <IntegrationDirectory
            entries={entries}
            custom={{
              label: m.integrations_admin_custom_server(),
              onPick: () => pick(customServer()),
            }}
            onPick={(entry) => {
              if (!create.isPending) pick(entry);
            }}
          />
        </DirectoryDialogContent>
      )}
    </Dialog>
  );
}

/** A known server that signs people in on its own needs no settings first. */
const readyAsAdded = (entry: DirectoryEntry) =>
  Boolean(entry.server && !findKnownMcpServer(entry.server)?.ownApp);
