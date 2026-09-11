import { Key01Icon } from "@hugeicons/core-free-icons";
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "~/ui/confirm.tsx";
import { useAppForm } from "~/ui/form/app-form.tsx";
import { EmptyState, FormActions, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Field, FieldDescription, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Switch } from "~/ui/primitives/switch";
import {
  OAUTH_BUILTINS,
  OIDC_DEFAULT_SCOPES,
  SaveOidcProviderInput,
  type OAuthBuiltin,
} from "../oauth.ts";
import {
  deleteOAuthProvider,
  listOAuthProviders,
  saveBuiltinOAuthProvider,
  saveOidcOAuthProvider,
} from "../server/oauth-functions.ts";
import type { PublicOAuthProvider } from "../server/oauth-repo.ts";

export const oauthProvidersQuery = queryOptions({
  queryKey: ["admin", "oauth"],
  queryFn: () => listOAuthProviders(),
});

const useInvalidateProviders = () => {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["admin", "oauth"] });
};

// Signing in is a redirect away and back, so the provider's console needs this
// exact URL registered. Showing it beats describing how to build it.
function CallbackUrl({ baseURL, id }: { baseURL: string | null; id: string }) {
  return (
    <Field>
      <FieldLabel htmlFor={`callback-${id}`}>Callback URL</FieldLabel>
      <Input id={`callback-${id}`} readOnly value={`${baseURL ?? ""}/api/auth/callback/${id}`} />
      <FieldDescription>
        {baseURL
          ? "Register this with the provider."
          : "Set BETTER_AUTH_URL so this URL is complete, then register it with the provider."}
      </FieldDescription>
    </Field>
  );
}

function SecretField({
  id,
  value,
  onChange,
  configured,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  configured: boolean;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={`secret-${id}`}>Client secret</FieldLabel>
      <Input
        id={`secret-${id}`}
        type="password"
        autoComplete="off"
        placeholder={configured ? "Unchanged" : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {configured ? (
        <FieldDescription>Leave empty to keep the stored secret.</FieldDescription>
      ) : null}
    </Field>
  );
}

export function OAuthPage() {
  const { data } = useSuspenseQuery(oauthProvidersQuery);
  const byId = new Map(data.providers.map((p) => [p.id, p]));

  return (
    <Page
      title="Sign-in"
      description="Providers users can sign in with, beside email and password."
    >
      <Section title="Providers">
        <ListCard>
          {OAUTH_BUILTINS.map((builtin) => (
            <BuiltinProvider
              key={builtin.id}
              builtin={builtin}
              provider={byId.get(builtin.id) ?? null}
              baseURL={data.baseURL}
            />
          ))}
        </ListCard>
      </Section>
      <OidcSection
        providers={data.providers.filter((p) => p.kind === "oidc")}
        baseURL={data.baseURL}
      />
    </Page>
  );
}

function BuiltinProvider({
  builtin,
  provider,
  baseURL,
}: {
  builtin: OAuthBuiltin;
  provider: PublicOAuthProvider | null;
  baseURL: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState("");
  const [clientId, setClientId] = useState(provider?.clientId ?? "");
  const storedExtra = String(provider?.config[builtin.field?.key ?? ""] ?? "");
  const [extra, setExtra] = useState(storedExtra);
  const invalidate = useInvalidateProviders();
  const confirm = useConfirm();

  // Saving sends the editor's fields; the row's toggle sends what is already
  // stored, so flipping it cannot commit an edit nobody pressed Save on.
  const submit = useMutation({
    mutationFn: ({ enabled, draft }: { enabled: boolean; draft: boolean }) =>
      saveBuiltinOAuthProvider({
        data: {
          id: builtin.id,
          enabled,
          clientId: draft ? clientId : (provider?.clientId ?? clientId),
          ...(draft && secret ? { secret } : {}),
          ...(builtin.field?.key === "tenantId" ? { tenantId: draft ? extra : storedExtra } : {}),
          ...(builtin.field?.key === "issuer" ? { issuer: draft ? extra : storedExtra } : {}),
        },
      }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setSecret("");
      await invalidate();
    },
    onError: () => toast.error(`Could not save ${builtin.label}.`),
  });

  const remove = useMutation({
    mutationFn: () => deleteOAuthProvider({ data: { id: builtin.id } }),
    onSuccess: invalidate,
    onError: () => toast.error(`Could not remove ${builtin.label}.`),
  });

  return (
    <>
      <ListRow>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="text-sm font-medium">{builtin.label}</span>
          {provider ? null : <Badge variant="outline">Not set up</Badge>}
        </div>
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
          {open ? "Close" : provider ? "Edit" : "Set up"}
        </Button>
        <Switch
          checked={provider?.enabled ?? false}
          disabled={!provider || submit.isPending}
          onCheckedChange={(checked) => submit.mutate({ enabled: checked, draft: false })}
          aria-label={`${builtin.label} enabled`}
        />
      </ListRow>
      {open ? (
        <ListRow className="flex-col items-stretch gap-3">
          <CallbackUrl baseURL={baseURL} id={builtin.id} />
          <Field>
            <FieldLabel htmlFor={`client-id-${builtin.id}`}>Client ID</FieldLabel>
            <Input
              id={`client-id-${builtin.id}`}
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
          </Field>
          <SecretField
            id={builtin.id}
            value={secret}
            onChange={setSecret}
            configured={provider?.secretConfigured ?? false}
          />
          {builtin.field ? (
            <Field>
              <FieldLabel htmlFor={`extra-${builtin.id}`}>{builtin.field.label}</FieldLabel>
              <Input
                id={`extra-${builtin.id}`}
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
              />
              <FieldDescription>{builtin.field.description}</FieldDescription>
            </Field>
          ) : null}
          <FormActions>
            <PendingButton
              size="sm"
              pending={submit.isPending}
              disabled={!clientId}
              onClick={() => submit.mutate({ enabled: provider?.enabled ?? false, draft: true })}
            >
              Save
            </PendingButton>
            {provider ? (
              <PendingButton
                size="sm"
                variant="destructive"
                pending={remove.isPending}
                onClick={async () => {
                  const confirmed = await confirm({
                    title: `Remove ${builtin.label}?`,
                    description: `The stored credentials are deleted, and anyone whose account signs in with ${builtin.label} cannot get in until it is set up again.`,
                    confirmLabel: "Remove",
                  });
                  if (confirmed) remove.mutate();
                }}
              >
                Remove
              </PendingButton>
            ) : null}
          </FormActions>
        </ListRow>
      ) : null}
    </>
  );
}

const OidcForm = Schema.Struct({
  id: SaveOidcProviderInput.fields.id,
  label: SaveOidcProviderInput.fields.label,
  discoveryUrl: Schema.String.check(Schema.isMinLength(1, { message: "Enter the discovery URL." })),
  scopes: Schema.String,
});

function OidcSection({
  providers,
  baseURL,
}: {
  providers: PublicOAuthProvider[];
  baseURL: string | null;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const invalidate = useInvalidateProviders();
  const confirm = useConfirm();

  const toggle = useMutation({
    mutationFn: (input: { provider: PublicOAuthProvider; enabled: boolean }) =>
      saveOidcOAuthProvider({
        data: {
          id: input.provider.id,
          label: input.provider.label,
          enabled: input.enabled,
          clientId: input.provider.clientId,
          discoveryUrl: String(input.provider.config.discoveryUrl ?? ""),
          scopes: (input.provider.config.scopes as string[] | undefined) ?? [],
        },
      }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await invalidate();
    },
    onError: () => toast.error("Could not update the provider."),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteOAuthProvider({ data: { id } }),
    onSuccess: invalidate,
    onError: () => toast.error("Could not remove the provider."),
  });

  return (
    <Section
      title="OpenID Connect"
      description="Any provider with a discovery document, such as Authentik, Keycloak or Okta."
      actions={
        <Button size="sm" variant="outline" onClick={() => setEditing("")}>
          New provider
        </Button>
      }
    >
      {editing === "" ? (
        <ListCard>
          <ListRow className="flex-col items-stretch gap-3">
            <OidcProviderForm
              provider={null}
              baseURL={baseURL}
              onDone={() => setEditing(null)}
              onSaved={invalidate}
            />
          </ListRow>
        </ListCard>
      ) : null}
      {providers.length === 0 && editing !== "" ? (
        <EmptyState icon={Key01Icon} title="No OpenID Connect providers" />
      ) : null}
      {providers.length > 0 ? (
        <ListCard>
          {providers.map((provider) => (
            <div key={provider.id} className="divide-border divide-y">
              <ListRow>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">{provider.label}</span>
                  <span className="text-muted-foreground text-xs">{provider.id}</span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing(editing === provider.id ? null : provider.id)}
                >
                  {editing === provider.id ? "Close" : "Edit"}
                </Button>
                <Switch
                  checked={provider.enabled}
                  disabled={toggle.isPending}
                  onCheckedChange={(checked) => toggle.mutate({ provider, enabled: checked })}
                  aria-label={`${provider.label} enabled`}
                />
              </ListRow>
              {editing === provider.id ? (
                <ListRow className="flex-col items-stretch gap-3">
                  <OidcProviderForm
                    provider={provider}
                    baseURL={baseURL}
                    onDone={() => setEditing(null)}
                    onSaved={invalidate}
                  />
                  <FormActions>
                    <PendingButton
                      size="sm"
                      variant="destructive"
                      pending={remove.isPending}
                      onClick={async () => {
                        const confirmed = await confirm({
                          title: `Remove “${provider.label}”?`,
                          description: `The stored credentials are deleted, and anyone whose account signs in with ${provider.label} cannot get in until it is set up again.`,
                          confirmLabel: "Remove",
                        });
                        if (confirmed) remove.mutate(provider.id);
                      }}
                    >
                      Remove
                    </PendingButton>
                  </FormActions>
                </ListRow>
              ) : null}
            </div>
          ))}
        </ListCard>
      ) : null}
    </Section>
  );
}

function OidcProviderForm({
  provider,
  baseURL,
  onDone,
  onSaved,
}: {
  provider: PublicOAuthProvider | null;
  baseURL: string | null;
  onDone: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const [clientId, setClientId] = useState(provider?.clientId ?? "");
  const [secret, setSecret] = useState("");

  const form = useAppForm({
    defaultValues: {
      id: provider?.id ?? "",
      label: provider?.label ?? "",
      discoveryUrl: String(provider?.config.discoveryUrl ?? ""),
      scopes: ((provider?.config.scopes as string[] | undefined) ?? OIDC_DEFAULT_SCOPES).join(" "),
    },
    validators: { onSubmit: Schema.toStandardSchemaV1(OidcForm) },
    onSubmit: async ({ value }) => {
      const result = await saveOidcOAuthProvider({
        data: {
          id: value.id,
          label: value.label,
          enabled: provider?.enabled ?? false,
          clientId,
          ...(secret ? { secret } : {}),
          discoveryUrl: value.discoveryUrl,
          scopes: value.scopes.split(/\s+/).filter(Boolean),
        },
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setSecret("");
      await onSaved();
      onDone();
    },
  });

  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      {provider ? <CallbackUrl baseURL={baseURL} id={provider.id} /> : null}
      {provider ? null : (
        <form.AppField name="id">
          {(field) => (
            <field.TextField
              label="Provider ID"
              description="Appears in the callback URL, and cannot be changed later. Lowercase letters, digits and dashes."
            />
          )}
        </form.AppField>
      )}
      <form.AppField name="label">
        {(field) => <field.TextField label="Button label" />}
      </form.AppField>
      <form.AppField name="discoveryUrl">
        {(field) => (
          <field.TextField
            label="Discovery URL"
            type="url"
            placeholder="https://id.example.com/.well-known/openid-configuration"
          />
        )}
      </form.AppField>
      <Field>
        <FieldLabel htmlFor={`oidc-client-${provider?.id ?? "new"}`}>Client ID</FieldLabel>
        <Input
          id={`oidc-client-${provider?.id ?? "new"}`}
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
        />
      </Field>
      <SecretField
        id={`oidc-${provider?.id ?? "new"}`}
        value={secret}
        onChange={setSecret}
        configured={provider?.secretConfigured ?? false}
      />
      <form.AppField name="scopes">
        {(field) => <field.TextField label="Scopes" description="Separated by spaces." />}
      </form.AppField>
      <FormActions>
        <form.AppForm>
          <form.SubmitButton size="sm" disabled={!clientId}>
            Save
          </form.SubmitButton>
        </form.AppForm>
        <Button size="sm" variant="ghost" type="button" onClick={onDone}>
          Cancel
        </Button>
      </FormActions>
    </form>
  );
}
