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
import { findIntegrationType } from "../catalog.ts";
import { connectUrl } from "../client/queries.ts";
import type { UserIntegration } from "../schema.ts";
import { connectIntegrationApiKey, connectIntegrationOpen } from "../server/functions.ts";
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
  const manifest = findIntegrationType(integration.kind);
  const [keyOpen, setKeyOpen] = useState(false);
  if (!manifest) return null;
  const reconnect = integration.connection?.status === "needs_reauth";
  // A server from a catalog is known by its own name, not its type's.
  const service = manifest.toolSource === "catalog" ? integration.name : manifest.name;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {/* One primary: no account first, then a sign-in, a token last. */}
      {integration.methods.open ? <TurnOnButton integration={integration} /> : null}
      {integration.methods.apiKey ? (
        <Button
          size="sm"
          variant={integration.methods.oauth || integration.methods.open ? "outline" : "default"}
          onClick={() => setKeyOpen(true)}
        >
          Use {manifest.apiKey?.noun ?? "an API key"}
        </Button>
      ) : null}
      {integration.methods.oauth ? (
        <SignInButton
          integration={integration}
          returnTo={returnTo}
          variant={integration.methods.open ? "outline" : "default"}
        >
          {reconnect ? "Reconnect" : `Sign in with ${service}`}
        </SignInButton>
      ) : null}
      {keyOpen ? <ApiKeyDialog integration={integration} open onOpenChange={setKeyOpen} /> : null}
    </div>
  );
}

/** For a server that needs no account of one's own: open, or the admin's shared key. */
export function TurnOnButton({
  integration,
  children = "Turn on",
}: {
  integration: UserIntegration;
  children?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const turnOn = useMutation({
    mutationFn: () => connectIntegrationOpen({ data: { integrationId: integration.id } }),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["integrations"] });
    },
    onError: () => setError(`Could not reach ${integration.name}.`),
  });
  return (
    <div className="flex flex-col items-end gap-1">
      <PendingButton size="sm" pending={turnOn.isPending} onClick={() => turnOn.mutate()}>
        {children}
      </PendingButton>
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}

/** Leaves the page for the service's sign-in; `returnTo` is where it comes back to. */
export function SignInButton({
  integration,
  returnTo,
  variant = "default",
  children,
}: {
  integration: UserIntegration;
  returnTo?: string | undefined;
  variant?: "default" | "outline";
  children: ReactNode;
}) {
  const desktop = useDesktop();
  return (
    <Button
      size="sm"
      variant={variant}
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
  const manifest = findIntegrationType(integration.kind)!;
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
    onError: () => setError("Could not check that."),
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
          <DialogTitle>
            Connect {integration.name} with {manifest.apiKey?.noun ?? "an API key"}
          </DialogTitle>
          <DialogDescription>
            It’s checked with {integration.name}, encrypted, and never shown again. Chats act with
            everything it can reach.
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
