import {
  Delete02Icon,
  Key01Icon,
  PencilEdit02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "~/ui/confirm-context.ts";
import { EmptyState, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Field, FieldDescription, FieldLabel } from "~/ui/primitives/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { Switch } from "~/ui/primitives/switch";
import { OAUTH_BUILTINS } from "../oauth.ts";
import { deleteOAuthProvider, setOAuthProviderEnabled } from "../server/oauth-functions.ts";
import type { PublicOAuthProvider } from "../server/oauth-repo.ts";
import { saveAuthSettings } from "../server/signup-functions.ts";
import {
  MAX_ADMIT_DOMAINS,
  parseDomain,
  SIGNUP_MODE_ITEMS,
  SIGNUP_MODE_LABELS,
  type AuthSettings,
  type SignupMode,
} from "../signup.ts";
import { OAuthProviderDialog } from "./oauth-provider-dialog.tsx";
import { toastError } from "~/ui/error-toast.ts";
import { authSettingsQuery, oauthProvidersQuery } from "../queries.ts";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxValue,
  useComboboxAnchor,
} from "~/ui/primitives/combobox";

// Approval is the ordinary case, so only the other two earn a badge.
const MODE_BADGES: Partial<Record<SignupMode, string>> = {
  open: "Joins directly",
  closed: "Sign-in only",
};

export function OAuthPage() {
  const { data } = useSuspenseQuery(oauthProvidersQuery);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin", "oauth"] });
  // Better Auth registers one account system per built-in, and the row's id is
  // its primary key, so a configured type has no second slot to offer.
  const available = OAUTH_BUILTINS.filter(
    (builtin) => !data.providers.some((p) => p.id === builtin.id),
  );
  const editing = data.providers.find((p) => p.id === editingId) ?? null;

  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      setOAuthProviderEnabled({ data: input }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await invalidate();
    },
    onError: (error) => toastError("Could not update the provider.", error),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteOAuthProvider({ data: { id } }),
    onSuccess: invalidate,
    onError: (error) => toastError("Could not remove the provider.", error),
  });

  const addButton = (
    <Button size="sm" onClick={() => setAdding(true)}>
      <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
      Add provider
    </Button>
  );

  return (
    <Page
      title="Sign-in"
      description="How people get into this instance and who can join."
      actions={addButton}
    >
      {data.providers.length === 0 ? (
        <EmptyState
          icon={Key01Icon}
          title="No sign-in providers yet"
          description="Connect Google, a company identity provider, or anything with an OpenID Connect discovery document."
          action={addButton}
        />
      ) : (
        <ListCard>
          {data.providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              pending={toggle.isPending || remove.isPending}
              onToggle={(enabled) => toggle.mutate({ id: provider.id, enabled })}
              onEdit={() => setEditingId(provider.id)}
              onRemove={async () => {
                const confirmed = await confirm({
                  title: `Remove “${provider.label}”?`,
                  description: `The stored credentials are deleted, and anyone whose account signs in with ${provider.label} cannot get in until it is set up again.`,
                  confirmLabel: "Remove provider",
                });
                if (confirmed) remove.mutate(provider.id);
              }}
            />
          ))}
        </ListCard>
      )}

      <PasswordSection />
      <DomainsSection />

      {adding ? (
        <OAuthProviderDialog
          provider={null}
          available={available}
          baseURL={data.baseURL}
          open
          onOpenChange={setAdding}
        />
      ) : null}
      {editing ? (
        <OAuthProviderDialog
          // Remounted per provider so the form starts from that row's values.
          key={editing.id}
          provider={editing}
          available={available}
          baseURL={data.baseURL}
          open
          onOpenChange={(next) => !next && setEditingId(null)}
        />
      ) : null}
    </Page>
  );
}

function ProviderRow({
  provider,
  pending,
  onToggle,
  onEdit,
  onRemove,
}: {
  provider: PublicOAuthProvider;
  pending: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <ListRow>
      <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
        <HugeiconsIcon icon={Key01Icon} strokeWidth={2} className="size-4" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 text-sm font-medium">
          <span className="min-w-0 truncate">{provider.label}</span>
          {MODE_BADGES[provider.signup] ? (
            <Badge variant="secondary">{MODE_BADGES[provider.signup]}</Badge>
          ) : null}
          {provider.trustEmails ? <Badge variant="secondary">Trusted emails</Badge> : null}
          {provider.exclusive ? <Badge variant="secondary">No passwords</Badge> : null}
        </span>
        {/* A built-in's label already names it; an OpenID Connect id is chosen,
            so it is the only one worth repeating under the name. */}
        {provider.kind === "oidc" ? (
          <span className="text-muted-foreground truncate text-xs">{provider.id}</span>
        ) : null}
      </div>
      <Switch
        checked={provider.enabled}
        disabled={pending}
        onCheckedChange={onToggle}
        aria-label={`${provider.label} enabled`}
      />
      <Button variant="ghost" size="icon-sm" aria-label={`Edit ${provider.label}`} onClick={onEdit}>
        <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${provider.label}`}
        disabled={pending}
        onClick={onRemove}
      >
        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
      </Button>
    </ListRow>
  );
}

function useSaveSettings() {
  const { data: settings } = useSuspenseQuery(authSettingsQuery);
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (patch: Partial<AuthSettings>) =>
      saveAuthSettings({
        data: {
          passwordSignup: settings.passwordSignup,
          passwordLogin: settings.passwordLogin,
          requireEmailVerification: settings.requireEmailVerification,
          admitDomains: [...settings.admitDomains],
          ...patch,
        },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "auth-settings"] }),
    onError: (error) => toastError("Could not save.", error),
  });
  return { settings, save };
}

function PasswordSection() {
  const fieldId = useId();
  const { settings, save } = useSaveSettings();
  // The server treats a forced switch as on, so the page does too.
  const passwordOn = settings.passwordLogin || settings.passwordLoginForced;

  return (
    <Section title="Email and password">
      <ListCard>
        <ListRow className="flex-col items-stretch gap-3">
          <Field>
            <div className="flex items-center justify-between gap-3">
              <FieldLabel htmlFor={`${fieldId}-login`}>Password sign-in</FieldLabel>
              <Switch
                id={`${fieldId}-login`}
                checked={passwordOn}
                onCheckedChange={(passwordLogin) => save.mutate({ passwordLogin })}
                disabled={save.isPending || settings.passwordLoginForced}
              />
            </div>
            <FieldDescription>
              {settings.passwordLoginForced
                ? "Kept on by AUTH_PASSWORD_LOGIN on the server."
                : "Off leaves only the providers above."}
            </FieldDescription>
          </Field>
        </ListRow>
        <ListRow className="flex-col items-stretch gap-3">
          <Field>
            <FieldLabel htmlFor={`${fieldId}-signup`}>New accounts</FieldLabel>
            <Select
              value={settings.passwordSignup}
              onValueChange={(passwordSignup) => passwordSignup && save.mutate({ passwordSignup })}
              items={SIGNUP_MODE_ITEMS}
              disabled={save.isPending || !passwordOn}
            >
              <SelectTrigger id={`${fieldId}-signup`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SIGNUP_MODE_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              {SIGNUP_MODE_LABELS[settings.passwordSignup].description}
            </FieldDescription>
          </Field>
        </ListRow>
        <ListRow className="flex-col items-stretch gap-3">
          <Field>
            <div className="flex items-center justify-between gap-3">
              <FieldLabel htmlFor={`${fieldId}-verify`}>Require email verification</FieldLabel>
              <Switch
                id={`${fieldId}-verify`}
                checked={settings.requireEmailVerification}
                onCheckedChange={(requireEmailVerification) =>
                  save.mutate({ requireEmailVerification })
                }
                disabled={
                  save.isPending || (!settings.smtpConfigured && !settings.requireEmailVerification)
                }
              />
            </div>
            <FieldDescription>
              {settings.smtpConfigured
                ? "Password accounts confirm their address before signing in. Only confirmed addresses can be found by email."
                : "Set up email under Email first."}
            </FieldDescription>
          </Field>
        </ListRow>
      </ListCard>
    </Section>
  );
}

function DomainsSection() {
  const fieldId = useId();
  const anchor = useComboboxAnchor();
  const { settings, save } = useSaveSettings();
  // Shown at once and saved behind it; a failed save puts the stored list back.
  const [domains, setDomains] = useState<readonly string[]>(settings.admitDomains);
  const [text, setText] = useState("");
  const [rejected, setRejected] = useState<string | null>(null);

  const apply = (next: readonly string[]) => {
    setDomains(next);
    save.mutate({ admitDomains: [...next] }, { onError: () => setDomains(settings.admitDomains) });
  };

  // Typed or pasted text becomes chips at a separator; anything that is not a domain stays put.
  const commit = (raw: string) => {
    const added: string[] = [];
    const left: string[] = [];
    for (const part of raw.split(/[\s,;]+/).filter(Boolean)) {
      const domain = parseDomain(part);
      if (domain && domains.length + added.length < MAX_ADMIT_DOMAINS) {
        if (!domains.includes(domain) && !added.includes(domain)) added.push(domain);
      } else left.push(part);
    }
    if (added.length) apply([...domains, ...added]);
    setText(left.join(" "));
    setRejected(left[0] ?? null);
  };

  return (
    <Section title="Domains">
      <ListCard>
        <ListRow className="flex-col items-stretch gap-3">
          <Field>
            <FieldLabel htmlFor={`${fieldId}-domains`}>Domains that join directly</FieldLabel>
            <Combobox
              multiple
              items={[...domains]}
              value={[...domains]}
              onValueChange={(next: string[]) => apply(next)}
              inputValue={text}
              onInputValueChange={(value: string) => {
                setRejected(null);
                if (/[\s,;]/.test(value)) commit(value);
                else setText(value);
              }}
            >
              <ComboboxChips ref={anchor} aria-invalid={rejected !== null}>
                <ComboboxValue>
                  {(value: string[]) => (
                    <>
                      {value.map((domain) => (
                        <ComboboxChip key={domain} aria-label={domain}>
                          {domain}
                        </ComboboxChip>
                      ))}
                      <ComboboxChipsInput
                        id={`${fieldId}-domains`}
                        placeholder={value.length ? "" : "example.com"}
                        disabled={domains.length >= MAX_ADMIT_DOMAINS}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && text.trim()) {
                            event.preventDefault();
                            commit(text);
                          }
                        }}
                        onBlur={() => {
                          if (text.trim()) commit(text);
                        }}
                      />
                    </>
                  )}
                </ComboboxValue>
              </ComboboxChips>
            </Combobox>
            <FieldDescription>
              {rejected
                ? `“${rejected}” isn’t a domain.`
                : "A verified address here gets in even where new accounts wait or are refused."}
            </FieldDescription>
          </Field>
        </ListRow>
      </ListCard>
    </Section>
  );
}
