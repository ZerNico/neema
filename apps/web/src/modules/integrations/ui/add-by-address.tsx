import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import { DialogFooter } from "~/ui/primitives/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { myIntegrationsQuery, personalServersQuery } from "../client/queries.ts";
import type { PersonalServer } from "../schema.ts";
import {
  deletePersonalServer,
  finishServerSetup,
  getServerSetup,
  probeServer,
  savePersonalServer,
} from "../server/functions.ts";
import { ConnectFlow } from "./connect-flow.tsx";
import { OAuthClientFields } from "./oauth-setup-guide.tsx";

/** For a server whose sign-in only takes apps registered there, which nothing here can do. */
const OWN_APP_SETUP = {
  console: null,
  steps: [
    {
      text: "This server only lets in apps registered with it. Register one there with this redirect URI, then paste its client ID and secret.",
    },
  ],
};

/**
 * A server of one's own by its address alone. The server is asked how it is
 * reached (open, signing in, or a token), so nobody has to know; then it is
 * connected like any other. One that needs an account stays out of every list
 * until its first account connects, and going back deletes it.
 */
export function AddByAddress({
  onBack,
  onDone,
  onOpenPage,
}: {
  onBack: () => void;
  onDone: () => void;
  onOpenPage: (integrationId: string) => void;
}) {
  const fieldId = useId();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  // Saved, but waiting for the person's own app before it can be signed into.
  const [needsApp, setNeedsApp] = useState<PersonalServer | null>(null);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: personalServersQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: myIntegrationsQuery.queryKey }),
    ]);

  const add = useMutation({
    mutationFn: async () => {
      const found = await probeServer({ data: { url } });
      if (!found.ok) return found;
      const saved = await savePersonalServer({
        data: { integrationId: null, name: found.name, config: { url, ways: found.ways } },
      });
      return saved.ok
        ? { ok: true as const, server: saved.server, needsClient: found.needsClient }
        : saved;
    },
    onSuccess: (result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.needsClient) setNeedsApp(result.server);
      else setAdded(result.server.id);
    },
    onError: () => setError("Could not reach the server."),
  });
  const withApp = useMutation({
    mutationFn: (server: PersonalServer) =>
      savePersonalServer({
        data: {
          integrationId: server.id,
          name: server.name,
          config: server.config,
          oauthClientId: clientId.trim(),
          oauthClientSecret: secret.trim(),
        },
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNeedsApp(null);
      setAdded(result.server.id);
    },
    onError: () => setError("Could not save the app."),
  });
  // Not signed into yet: nothing of it stays behind.
  const discard = (integrationId: string) =>
    void deletePersonalServer({ data: { integrationId } }).then(refresh);
  // Under `integrations`, so the sync event an account brings refetches it.
  const setup = useQuery({
    queryKey: ["integrations", "setup", added],
    queryFn: () => getServerSetup({ data: { integrationId: added! } }),
    enabled: added !== null,
  });
  const live = setup.data?.ok ? setup.data.integration : undefined;

  if (added && live)
    return (
      <ConnectFlow
        integration={live}
        live={live}
        fresh
        onBack={() => {
          discard(added);
          setAdded(null);
        }}
        onReady={() => void finishServerSetup({ data: { integrationId: added } }).then(refresh)}
        onDone={onDone}
        onOpenPage={() => onOpenPage(added)}
      />
    );

  if (needsApp)
    return (
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          withApp.mutate(needsApp);
        }}
      >
        <FieldGroup>
          <OAuthClientFields
            id={fieldId}
            setup={OWN_APP_SETUP}
            redirectUri={
              needsApp.redirectUri ??
              `${window.location.origin}/api/integrations/${needsApp.id}/callback`
            }
            config={needsApp.config}
            clientId={clientId}
            onClientIdChange={setClientId}
            secret={secret}
            onSecretChange={setSecret}
            secretStored={false}
            optional={false}
            disabled={withApp.isPending}
          />
        </FieldGroup>
        {error ? <FieldError>{error}</FieldError> : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={withApp.isPending}
            onClick={() => {
              discard(needsApp.id);
              setNeedsApp(null);
              setError(null);
            }}
          >
            Back
          </Button>
          <PendingButton type="submit" pending={withApp.isPending} disabled={!clientId.trim()}>
            Continue
          </PendingButton>
        </DialogFooter>
      </form>
    );

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        add.mutate();
      }}
    >
      <Field>
        <FieldLabel htmlFor={`${fieldId}-url`}>Server address</FieldLabel>
        <Input
          id={`${fieldId}-url`}
          type="url"
          placeholder="https://mcp.example.com/mcp"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={add.isPending || added !== null || needsApp !== null}
        />
        <FieldDescription>Its public HTTPS address. Only you use it.</FieldDescription>
      </Field>
      {error ? <FieldError>{error}</FieldError> : null}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={add.isPending} onClick={onBack}>
          Back
        </Button>
        <PendingButton
          type="submit"
          pending={add.isPending || (added !== null && !live)}
          disabled={!url.trim()}
        >
          Continue
        </PendingButton>
      </DialogFooter>
    </form>
  );
}
