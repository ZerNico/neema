import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import { useDesktop } from "~/modules/desktop/client/bridge.ts";
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
import { FieldDescription, FieldError, FieldGroup } from "~/ui/primitives/field";
import { findIntegration } from "../catalog.ts";
import { connectUrl } from "../client/queries.ts";
import type { UserIntegration } from "../schema.ts";
import { connectIntegrationApiKey } from "../server/functions.ts";
import { IntegrationFieldControl } from "./integration-field.tsx";

/**
 * The ways to connect one integration: an API key, OAuth, or both, as the
 * admin allowed. OAuth leaves the page; `returnTo` is where it comes back to.
 */
export function ConnectActions({
  integration,
  returnTo,
}: {
  integration: UserIntegration;
  returnTo?: string;
}) {
  const manifest = findIntegration(integration.id);
  const [keyOpen, setKeyOpen] = useState(false);
  if (!manifest) return null;
  const reconnect = integration.connection?.status === "needs_reauth";
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {integration.methods.apiKey ? (
        <Button
          size="sm"
          variant={integration.methods.oauth ? "outline" : "default"}
          onClick={() => setKeyOpen(true)}
        >
          Use an API key
        </Button>
      ) : null}
      {integration.methods.oauth ? (
        <SignInButton integration={integration} returnTo={returnTo}>
          {reconnect ? "Reconnect" : `Sign in with ${manifest.name}`}
        </SignInButton>
      ) : null}
      {keyOpen ? <ApiKeyDialog integration={integration} open onOpenChange={setKeyOpen} /> : null}
    </div>
  );
}

/** Leaves the page for the service's sign-in; `returnTo` is where it comes back to. */
export function SignInButton({
  integration,
  returnTo,
  children,
}: {
  integration: UserIntegration;
  returnTo?: string | undefined;
  children: ReactNode;
}) {
  const desktop = useDesktop();
  return (
    <Button
      size="sm"
      // In the desktop app a new-window link goes to the system browser,
      // which is where the sign-in has to happen; a browser tab just goes.
      render={
        <a href={connectUrl(integration.id, returnTo)} target={desktop ? "_blank" : undefined} />
      }
    >
      {children}
    </Button>
  );
}

export function ApiKeyDialog({
  integration,
  open,
  onOpenChange,
}: {
  integration: UserIntegration;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const manifest = findIntegration(integration.id)!;
  const fields = manifest.apiKey?.fields ?? [];
  const fieldId = useId();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const complete = fields.every((field) => !field.required || values[field.key]?.trim());
  const save = useMutation({
    mutationFn: () => connectIntegrationApiKey({ data: { integrationId: integration.id, values } }),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["integrations"] });
      onOpenChange(false);
    },
    onError: () => setError("Could not check that key."),
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
          <DialogTitle>Connect {manifest.name} with an API key</DialogTitle>
          <DialogDescription>
            The key is checked with {manifest.name}, encrypted, and never shown again. Chats act
            with everything it can reach.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            if (complete) save.mutate();
          }}
        >
          <FieldGroup>
            {fields.map((field) => (
              <IntegrationFieldControl
                key={field.key}
                id={`${fieldId}-${field.key}`}
                field={field}
                value={values[field.key] ?? ""}
                onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
                disabled={save.isPending}
              >
                {field.kind === "secret" && integration.apiKeyHelpUrl ? (
                  <FieldDescription>
                    Create one in{" "}
                    <a
                      href={integration.apiKeyHelpUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-4"
                    >
                      {manifest.name} settings
                    </a>
                    .
                  </FieldDescription>
                ) : null}
              </IntegrationFieldControl>
            ))}
          </FieldGroup>
          {error ? <FieldError>{error}</FieldError> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
              Cancel
            </DialogClose>
            <PendingButton type="submit" pending={save.isPending} disabled={!complete}>
              Connect
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
