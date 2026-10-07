import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { Switch } from "~/ui/primitives/switch";
import { OptionalMark } from "~/ui/form/form-fields.tsx";
import { findBuiltin, OIDC_DEFAULT_SCOPES, type OAuthBuiltin } from "../oauth.ts";
import { saveBuiltinOAuthProvider, saveOidcOAuthProvider } from "../server/oauth-functions.ts";
import type { PublicOAuthProvider } from "../server/oauth-repo.ts";

const OIDC = "oidc";

interface Draft {
  /** A built-in's id, or `oidc` for a provider reached by discovery. */
  type: string;
  id: string;
  label: string;
  clientId: string;
  secret: string;
  extra: string;
  discoveryUrl: string;
  scopes: string;
  trusted: boolean;
}

const emptyDraft = (type: string): Draft => ({
  type,
  id: "",
  label: "",
  clientId: "",
  secret: "",
  extra: "",
  discoveryUrl: "",
  scopes: OIDC_DEFAULT_SCOPES.join(" "),
  trusted: false,
});

const draftOf = (provider: PublicOAuthProvider): Draft => ({
  type: provider.kind === "oidc" ? OIDC : provider.id,
  id: provider.id,
  label: provider.label,
  clientId: provider.clientId,
  secret: "",
  extra: String(provider.config[findBuiltin(provider.id)?.field?.key ?? ""] ?? ""),
  discoveryUrl: String(provider.config.discoveryUrl ?? ""),
  scopes: ((provider.config.scopes as string[] | undefined) ?? OIDC_DEFAULT_SCOPES).join(" "),
  trusted: provider.trusted,
});

/**
 * Add and edit are one dialog because they ask for the same things; only the
 * type and an OpenID Connect provider's id are fixed once saved, since both
 * are baked into the callback URL that accounts were created through.
 */
export function OAuthProviderDialog({
  provider,
  available,
  baseURL,
  open,
  onOpenChange,
}: {
  /** Null when adding. */
  provider: PublicOAuthProvider | null;
  /** Built-ins not configured yet; a built-in fills its one slot. */
  available: readonly OAuthBuiltin[];
  baseURL: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fieldId = useId();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() =>
    provider ? draftOf(provider) : emptyDraft(available[0]?.id ?? OIDC),
  );
  const [error, setError] = useState<string | null>(null);
  const patch = (next: Partial<Draft>) => setDraft((d) => ({ ...d, ...next }));

  const builtin = draft.type === OIDC ? null : findBuiltin(draft.type);
  const id = builtin ? builtin.id : draft.id;
  const typeItems = [
    ...available.map((b) => ({ value: b.id, label: b.label })),
    { value: OIDC, label: "OpenID Connect" },
  ];

  const complete = Boolean(
    draft.clientId.trim() &&
    (provider ? true : draft.secret.trim()) &&
    (builtin || (draft.id.trim() && draft.label.trim() && draft.discoveryUrl.trim())),
  );

  const save = useMutation({
    mutationFn: async () => {
      const secret = draft.secret.trim();
      return builtin
        ? saveBuiltinOAuthProvider({
            data: {
              id: builtin.id,
              // Adding turns it on: the callback URL is on screen to register,
              // and a provider nobody can use is not what Add meant.
              enabled: provider?.enabled ?? true,
              trusted: draft.trusted,
              clientId: draft.clientId.trim(),
              ...(secret ? { secret } : {}),
              ...(builtin.field?.key === "tenantId" ? { tenantId: draft.extra.trim() } : {}),
              ...(builtin.field?.key === "issuer" ? { issuer: draft.extra.trim() } : {}),
            },
          })
        : saveOidcOAuthProvider({
            data: {
              id: draft.id.trim(),
              label: draft.label.trim(),
              enabled: provider?.enabled ?? true,
              trusted: draft.trusted,
              clientId: draft.clientId.trim(),
              ...(secret ? { secret } : {}),
              discoveryUrl: draft.discoveryUrl.trim(),
              scopes: draft.scopes.split(/\s+/).filter(Boolean),
            },
          });
    },
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["admin", "oauth"] });
      onOpenChange(false);
    },
    onError: () => setError("Could not save the provider."),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && save.isPending) return;
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{provider ? `Edit ${provider.label}` : "Add provider"}</DialogTitle>
          <DialogDescription>
            The client secret is encrypted at rest and never shown again.
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
            {provider ? null : (
              <Field>
                <FieldLabel htmlFor={`${fieldId}-type`}>Type</FieldLabel>
                <Select
                  value={draft.type}
                  onValueChange={(type) => type && patch({ ...emptyDraft(type) })}
                  items={typeItems}
                  disabled={save.isPending}
                >
                  <SelectTrigger id={`${fieldId}-type`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {typeItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {available.length === 0 ? (
                  <FieldDescription>Every built-in provider is already set up.</FieldDescription>
                ) : null}
              </Field>
            )}

            {builtin ? null : (
              <>
                <Field>
                  <FieldLabel htmlFor={`${fieldId}-id`}>Provider ID</FieldLabel>
                  <Input
                    id={`${fieldId}-id`}
                    value={draft.id}
                    onChange={(e) => patch({ id: e.target.value })}
                    placeholder="authentik"
                    disabled={save.isPending || Boolean(provider)}
                  />
                  <FieldDescription>
                    {provider
                      ? "Fixed: accounts were created through the callback URL it builds."
                      : "Lowercase letters, digits and dashes. Appears in the callback URL."}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${fieldId}-label`}>Button label</FieldLabel>
                  <Input
                    id={`${fieldId}-label`}
                    value={draft.label}
                    onChange={(e) => patch({ label: e.target.value })}
                    placeholder="Company SSO"
                    disabled={save.isPending}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${fieldId}-discovery`}>Discovery URL</FieldLabel>
                  <Input
                    id={`${fieldId}-discovery`}
                    type="url"
                    value={draft.discoveryUrl}
                    onChange={(e) => patch({ discoveryUrl: e.target.value })}
                    placeholder="https://id.example.com/.well-known/openid-configuration"
                    disabled={save.isPending}
                  />
                </Field>
              </>
            )}

            <Field>
              <FieldLabel htmlFor={`${fieldId}-callback`}>Callback URL</FieldLabel>
              <Input
                id={`${fieldId}-callback`}
                readOnly
                value={id ? `${baseURL ?? ""}/api/auth/callback/${id}` : ""}
              />
              <FieldDescription>
                {baseURL
                  ? "Register this with the provider before signing in."
                  : "Set PUBLIC_URL so this URL is complete, then register it with the provider."}
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor={`${fieldId}-client`}>Client ID</FieldLabel>
              <Input
                id={`${fieldId}-client`}
                value={draft.clientId}
                onChange={(e) => patch({ clientId: e.target.value })}
                disabled={save.isPending}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${fieldId}-secret`}>Client secret</FieldLabel>
              <Input
                id={`${fieldId}-secret`}
                type="password"
                autoComplete="off"
                placeholder={provider?.secretConfigured ? "Unchanged" : undefined}
                value={draft.secret}
                onChange={(e) => patch({ secret: e.target.value })}
                disabled={save.isPending}
              />
              {provider?.secretConfigured ? (
                <FieldDescription>Leave empty to keep the stored secret.</FieldDescription>
              ) : null}
            </Field>

            {builtin?.field ? (
              <Field>
                <FieldLabel htmlFor={`${fieldId}-extra`}>
                  {builtin.field.label} <OptionalMark />
                </FieldLabel>
                <Input
                  id={`${fieldId}-extra`}
                  value={draft.extra}
                  onChange={(e) => patch({ extra: e.target.value })}
                  disabled={save.isPending}
                />
                <FieldDescription>{builtin.field.description}</FieldDescription>
              </Field>
            ) : null}

            {builtin ? null : (
              <Field>
                <FieldLabel htmlFor={`${fieldId}-scopes`}>
                  Scopes <OptionalMark />
                </FieldLabel>
                <Input
                  id={`${fieldId}-scopes`}
                  value={draft.scopes}
                  onChange={(e) => patch({ scopes: e.target.value })}
                  disabled={save.isPending}
                />
                <FieldDescription>Separated by spaces.</FieldDescription>
              </Field>
            )}

            <Field>
              {/* The description sits outside the label: Base UI points the
                  switch at it with aria-labelledby, so anything in there ends
                  up read aloud as the control's name. */}
              <div className="flex items-center justify-between gap-3">
                <FieldLabel htmlFor={`${fieldId}-trusted`}>Skip approval</FieldLabel>
                <Switch
                  id={`${fieldId}-trusted`}
                  checked={draft.trusted}
                  onCheckedChange={(trusted) => patch({ trusted })}
                  disabled={save.isPending}
                />
              </div>
              <FieldDescription>
                New accounts from this provider are approved automatically.
              </FieldDescription>
            </Field>
          </FieldGroup>
          {error ? <FieldError>{error}</FieldError> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
              Cancel
            </DialogClose>
            <PendingButton type="submit" pending={save.isPending} disabled={!complete}>
              {provider ? "Save" : "Add provider"}
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
