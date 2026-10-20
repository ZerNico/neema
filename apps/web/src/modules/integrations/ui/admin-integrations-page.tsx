import { Add01Icon, ArrowRight01Icon, PlugSocketIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { EmptyState, ListCard, ListRow, Page } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "~/ui/primitives/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { integrationLook } from "../client/directory.ts";
import { adminIntegrationsQuery } from "../client/queries.ts";
import { mcpManifest } from "../mcp/manifest.ts";
import { createIntegration } from "../server/functions.ts";
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

export function AdminIntegrationsPage() {
  const { data } = useSuspenseQuery(adminIntegrationsQuery);
  const [adding, setAdding] = useState(false);
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
            const look = integrationLook(row);
            if (!look) return null;
            const people =
              row.connectionCount === 1
                ? "1 person connected"
                : `${row.connectionCount} people connected`;
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
                      {row.enabled ? null : <Badge variant="outline">Off</Badge>}
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
const CUSTOM_SERVER: DirectoryEntry = {
  key: "mcp",
  kind: "mcp",
  server: null,
  integrationId: null,
  name: "MCP server",
  description: mcpManifest.description,
  category: null,
  logo: mcpManifest.logo,
};

/**
 * One directory of everything an admin can offer. A known server is added
 * as it is, on and ready for people to connect; a type or an address is
 * named here, then set up on its page.
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
  const fieldId = useId();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [picked, setPicked] = useState<DirectoryEntry | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (entry: DirectoryEntry) =>
      createIntegration({
        data: {
          kind: entry.kind,
          name: name.trim(),
          ...(entry.server ? { server: entry.server } : {}),
        },
      }),
    onSuccess: async (result, entry) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: adminIntegrationsQuery.queryKey });
      onOpenChange(false);
      // A known server is ready as it is; anything else opens on its settings.
      void navigate({
        to: "/admin/integrations/$integrationId",
        params: { integrationId: result.id },
        search: entry.server ? {} : { setup: true },
      });
    },
    onError: () => setError("Could not add the integration."),
  });
  const entries = [
    ...TYPE_ENTRIES,
    ...SERVER_ENTRIES.filter((entry) => entry.server && !added.includes(entry.server)),
  ].toSorted(byName);
  const pick = (entry: DirectoryEntry) => {
    setPicked(entry);
    setName(freeName(entry.name, takenNames));
    setError(null);
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && create.isPending) return;
        onOpenChange(next);
      }}
    >
      {picked ? (
        <DirectoryDialogContent>
          <DialogHeader>
            <DialogTitle>Add {picked.name}</DialogTitle>
          </DialogHeader>
          <form
            className="flex flex-col gap-6"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              create.mutate(picked);
            }}
          >
            <FieldGroup>
              <Field>
                <DirectoryEntryHeader entry={picked} />
                <FieldDescription>
                  {picked.server
                    ? "Everyone can connect their own account once it’s added."
                    : picked.kind === "mcp"
                      ? "You enter its address next."
                      : "You fill in its settings next."}
                </FieldDescription>
              </Field>
              {picked.server ? null : (
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
              )}
            </FieldGroup>
            {error ? <FieldError>{error}</FieldError> : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={create.isPending}
                onClick={() => setPicked(null)}
              >
                Back
              </Button>
              <PendingButton type="submit" pending={create.isPending} disabled={!name.trim()}>
                Add
              </PendingButton>
            </DialogFooter>
          </form>
        </DirectoryDialogContent>
      ) : (
        <DirectoryDialogContent browsing={entries}>
          <DialogHeader>
            <DialogTitle>Add integration</DialogTitle>
          </DialogHeader>
          <IntegrationDirectory
            entries={entries}
            custom={{ label: "MCP server", onPick: () => pick(CUSTOM_SERVER) }}
            onPick={pick}
          />
        </DirectoryDialogContent>
      )}
    </Dialog>
  );
}
