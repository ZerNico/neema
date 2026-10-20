import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import { DialogFooter } from "~/ui/primitives/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { myIntegrationsQuery, personalServersQuery } from "../client/queries.ts";
import {
  deletePersonalServer,
  finishServerSetup,
  getServerSetup,
  probeServer,
  savePersonalServer,
} from "../server/functions.ts";
import { ConnectFlow } from "./connect-flow.tsx";

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
      return saved.ok ? { ok: true as const, id: saved.server.id } : saved;
    },
    onSuccess: (result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAdded(result.id);
    },
    onError: () => setError("Could not reach the server."),
  });
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
          // Not connected: nothing of it stays behind.
          void deletePersonalServer({ data: { integrationId: added } }).then(refresh);
          setAdded(null);
        }}
        onReady={() => void finishServerSetup({ data: { integrationId: added } }).then(refresh)}
        onDone={onDone}
        onOpenPage={() => onOpenPage(added)}
      />
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
          disabled={add.isPending || added !== null}
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
