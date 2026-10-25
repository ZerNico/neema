import { getLocale } from "~/paraglide/runtime.js";
import { m } from "~/paraglide/messages.js";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSessionUser } from "~/modules/auth/client.ts";
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
 * `another` offers only the ways that add an account of one's own.
 */
export function ConnectActions({
  integration,
  returnTo,
  another = false,
}: {
  integration: UserIntegration;
  returnTo?: string;
  another?: boolean;
}) {
  const manifest = findIntegrationType(integration.kind);
  const [keyOpen, setKeyOpen] = useState(false);
  if (!manifest) return null;
  // A server from a catalog is known by its own name, not its type's.
  const service = manifest.toolSource === "listed" ? integration.name : manifest.name;
  const open = !another && integration.methods.open;
  const keyNoun = manifest.apiKey?.noun?.(getLocale()) ?? m.integrations_api_key_noun();
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {/* One primary: no account first, then a sign-in, a token last. */}
      {open ? <TurnOnButton integration={integration} /> : null}
      {integration.methods.apiKey ? (
        <Button
          size="sm"
          variant={integration.methods.oauth || open || another ? "outline" : "default"}
          onClick={() => setKeyOpen(true)}
        >
          {m.integrations_connect_use_key({ noun: keyNoun })}
        </Button>
      ) : null}
      {integration.methods.oauth ? (
        <SignInButton
          integration={integration}
          returnTo={returnTo}
          variant={open || another ? "outline" : "default"}
        >
          {another
            ? m.integrations_connect_sign_in()
            : m.integrations_connect_sign_in_with({ service })}
        </SignInButton>
      ) : null}
      {keyOpen ? <ApiKeyDialog integration={integration} open onOpenChange={setKeyOpen} /> : null}
    </div>
  );
}

/** For a server that needs no account of one's own: open, or the admin's shared key. */
export function TurnOnButton({
  integration,
  children = m.integrations_connect_turn_on(),
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
    onError: () => setError(m.integrations_connect_unreachable({ name: integration.name })),
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

/**
 * Leaves the page for the service's sign-in; `returnTo` is where it comes
 * back to. With `connectionId` it reconnects that account, else adds one.
 */
export function SignInButton({
  integration,
  returnTo,
  connectionId,
  variant = "default",
  children,
}: {
  integration: UserIntegration;
  returnTo?: string | undefined;
  connectionId?: string | undefined;
  variant?: "default" | "outline";
  children: ReactNode;
}) {
  const desktop = useDesktop();
  // Every link names who asked: the system browser may be signed in as someone else.
  const me = useSessionUser();
  return (
    <Button
      size="sm"
      variant={variant}
      // In the desktop app a new-window link goes to the system browser,
      // which is where the sign-in has to happen; a browser tab just goes.
      render={
        <a
          href={connectUrl(integration.id, {
            ...(returnTo ? { returnTo } : {}),
            ...(connectionId ? { connectionId } : {}),
            ...(me ? { as: me.id } : {}),
          })}
          target={desktop ? "_blank" : undefined}
        />
      }
    >
      {children}
    </Button>
  );
}

/** A key for another account, or with `connectionId` a new key for that one. */
export function ApiKeyDialog({
  integration,
  connectionId,
  open,
  onOpenChange,
}: {
  integration: UserIntegration;
  connectionId?: string;
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
  // The sentence around the settings link, split where the link goes.
  const createIn = m.integrations_key_create_in({ settings: "\u0001" }).split("\u0001");
  const save = useMutation({
    mutationFn: () =>
      connectIntegrationApiKey({
        data: { integrationId: integration.id, values, ...(connectionId ? { connectionId } : {}) },
      }),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["integrations"] });
      onOpenChange(false);
    },
    onError: () => setError(m.integrations_key_check_error()),
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
            {m.integrations_key_title({
              name: integration.name,
              noun: manifest.apiKey?.noun?.(getLocale()) ?? m.integrations_api_key_noun(),
            })}
          </DialogTitle>
          <DialogDescription>
            {m.integrations_key_description({ name: integration.name })}
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
                    {createIn[0]}
                    <a
                      href={integration.apiKeyHelpUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-4"
                    >
                      {m.integrations_key_settings_link({ name: manifest.name })}
                    </a>
                    {createIn[1]}
                  </FieldDescription>
                ) : null}
              </IntegrationFieldControl>
            ))}
          </FieldGroup>
          {error ? <FieldError>{error}</FieldError> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
              {m.common_cancel()}
            </DialogClose>
            <PendingButton type="submit" pending={save.isPending} disabled={!complete}>
              {m.integrations_key_connect()}
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
