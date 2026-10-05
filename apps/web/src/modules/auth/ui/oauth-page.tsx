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
import { setSignupPolicy } from "../server/signup-functions.ts";
import { SIGNUP_POLICIES, SIGNUP_POLICY_LABELS, type SignupPolicy } from "../signup.ts";
import { OAuthProviderDialog } from "./oauth-provider-dialog.tsx";
import { toastError } from "~/ui/error-toast.ts";
import { oauthProvidersQuery, signupPolicyQuery } from "../queries.ts";

const POLICY_ITEMS = SIGNUP_POLICIES.map((value) => ({
  value,
  label: SIGNUP_POLICY_LABELS[value].title,
}));

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
      description="How people get into this instance, beside email and password."
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

      <SignupPolicySection />

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
          {provider.trusted ? <Badge variant="secondary">Skips approval</Badge> : null}
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

function SignupPolicySection() {
  const fieldId = useId();
  const { data: policy } = useSuspenseQuery(signupPolicyQuery);
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (next: SignupPolicy) => setSignupPolicy({ data: { policy: next } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "signup-policy"] }),
    onError: (error) => toastError("Could not change who can join.", error),
  });

  return (
    <Section title="New accounts">
      <ListCard>
        <ListRow className="flex-col items-stretch gap-3">
          <Field>
            <FieldLabel htmlFor={fieldId}>Who can join</FieldLabel>
            <Select
              value={policy}
              onValueChange={(value) => value && save.mutate(value as SignupPolicy)}
              items={POLICY_ITEMS}
              disabled={save.isPending}
            >
              <SelectTrigger id={fieldId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {POLICY_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>{SIGNUP_POLICY_LABELS[policy].description}</FieldDescription>
          </Field>
        </ListRow>
      </ListCard>
    </Section>
  );
}
