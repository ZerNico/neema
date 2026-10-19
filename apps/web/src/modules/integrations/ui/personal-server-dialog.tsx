import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
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
import { mcpManifest } from "../mcp/manifest.ts";
import { PERSONAL_SERVER_FIELDS, type PersonalServer } from "../schema.ts";
import { savePersonalServer } from "../server/functions.ts";
import { IntegrationFieldControl } from "./integration-field.tsx";

const MCP_FIELDS: ReadonlyArray<IntegrationField> = mcpManifest.adminFields;

/**
 * The MCP setup a person fills in for their own server, worded for them. An
 * admin may offer several ways in to different people; one person picks one.
 */
const FIELDS = MCP_FIELDS.flatMap((field): IntegrationField[] => {
  if (!PERSONAL_SERVER_FIELDS.some((key) => key === field.key)) return [];
  if (field.key === "url")
    return [{ ...field, description: "Its public HTTPS address. Older SSE servers work too." }];
  if (field.key === "ways")
    return [
      {
        ...field,
        kind: "choice",
        label: "Account",
        options: [
          { value: "anonymous", label: "No account", description: "The server needs nothing." },
          { value: "oauth", label: "Sign in", description: "With your account on the server." },
          { value: "token", label: "Token", description: "Pasted from your account there." },
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

/** Adds or edits an MCP server of one's own; a new one opens on its page to review its tools. */
export function PersonalServerDialog({
  server,
  open,
  onOpenChange,
}: {
  server: PersonalServer | null;
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
  const [error, setError] = useState<string | null>(null);
  const shown = FIELDS.filter((field) => fieldShown(field, config, FIELDS));

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: personalServersQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: myIntegrationsQuery.queryKey }),
    ]);
  const save = useMutation({
    mutationFn: () =>
      savePersonalServer({
        data: {
          integrationId: server?.id ?? null,
          name: name.trim(),
          // Only what is shown: a header left from a way since unticked is not sent.
          config: Object.fromEntries(shown.map((field) => [field.key, config[field.key] ?? ""])),
        },
      }),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await refresh();
      onOpenChange(false);
      if (!server)
        void navigate({
          to: "/settings/integrations/$integrationId",
          params: { integrationId: result.server.id },
        });
    },
    onError: () => setError("Could not save the server."),
  });
  const busy = save.isPending;

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
          <DialogTitle>{server ? `Set up ${server.name}` : "Add an MCP server"}</DialogTitle>
          <DialogDescription>
            Only you use it. Chats get only the tools you approve.
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
                disabled={busy}
              />
            </Field>
            {shown.map((field) => (
              <IntegrationFieldControl
                key={field.key}
                id={`${fieldId}-${field.key}`}
                field={field}
                value={config[field.key] ?? ""}
                onChange={(value) => setConfig((current) => ({ ...current, [field.key]: value }))}
                disabled={busy}
              />
            ))}
          </FieldGroup>
          {error ? <FieldError>{error}</FieldError> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</DialogClose>
            <PendingButton type="submit" pending={save.isPending} disabled={!name.trim()}>
              {server ? "Save" : "Add"}
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
