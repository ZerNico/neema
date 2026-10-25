import { Copy01Icon, Key01Icon, PlusSignIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { apiKeysQuery } from "~/modules/api-keys/client/queries.ts";
import {
  API_KEY_DAYS,
  type ApiKeyLifetime,
  type ApiKeySummary,
} from "~/modules/api-keys/schema.ts";
import { createApiKey, revokeApiKey } from "~/modules/api-keys/server/functions.ts";
import { accessSummary, MCP_SCOPES, type McpScope } from "~/modules/mcp-server/scopes.ts";
import { ScopePicker } from "~/modules/mcp-server/ui/scope-picker.tsx";
import { useConfirm } from "~/ui/confirm-context.ts";
import { toastError } from "~/ui/error-toast.ts";
import { EmptyState, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
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
import { Field, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";

const when = (value: Date | string) =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium" }).format(new Date(value));

// A function, so the labels are read in the locale of the page.
const lifetimes = (): ReadonlyArray<{ value: string; label: string; days: ApiKeyLifetime }> => [
  ...API_KEY_DAYS.map((days) => ({
    value: String(days),
    label:
      days === 365
        ? m.settings_api_keys_lifetime_year()
        : m.settings_api_keys_lifetime_days({ count: days }),
    days,
  })),
  { value: "never", label: m.settings_api_keys_never_expires(), days: null },
];

const READ_SCOPES = MCP_SCOPES.filter((scope) => !scope.endsWith(":write"));

const lifeLine = (key: ApiKeySummary) => {
  if (!key.expiresAt) return m.settings_api_keys_never_expires();
  return new Date(key.expiresAt) <= new Date()
    ? m.settings_api_keys_expired({ date: when(key.expiresAt) })
    : m.settings_api_keys_expires({ date: when(key.expiresAt) });
};

export function ApiKeysPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { data } = useSuspenseQuery(apiKeysQuery);
  const [creating, setCreating] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeApiKey({ data: { id } }),
    onSuccess: refresh,
    onError: (error) => toastError(m.settings_api_keys_error_revoke(), error),
  });

  return (
    <Page
      title={m.settings_section_api_keys()}
      description={m.settings_api_keys_description()}
      rootPath="/settings"
      rootLabel={m.common_settings()}
    >
      <Section
        title={m.settings_api_keys_keys()}
        actions={
          data.allowed && data.serverUrl ? (
            <Button variant="outline" onClick={() => setCreating(true)}>
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
              {m.settings_api_keys_new()}
            </Button>
          ) : null
        }
      >
        {data.allowed ? null : (
          <p className="text-muted-foreground text-sm">{m.settings_api_keys_not_allowed()}</p>
        )}
        {data.keys.length === 0 ? (
          <EmptyState icon={Key01Icon} title={m.settings_api_keys_empty()} />
        ) : (
          <ListCard>
            {data.keys.map((key) => (
              <ListRow key={key.id}>
                <HugeiconsIcon
                  icon={Key01Icon}
                  strokeWidth={2}
                  className="text-muted-foreground size-5 shrink-0"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium">
                    {key.name}
                    <span className="text-muted-foreground font-mono font-normal">
                      {" "}
                      · {key.start}…
                    </span>
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {accessSummary(key.scopes)} · {lifeLine(key)} ·{" "}
                    {key.lastUsedAt
                      ? m.settings_api_keys_last_used({ date: when(key.lastUsedAt) })
                      : m.settings_api_keys_never_used()}
                  </span>
                </div>
                <PendingButton
                  variant="ghost"
                  size="sm"
                  pending={revoke.isPending && revoke.variables === key.id}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: m.settings_api_keys_revoke_title({ name: key.name }),
                        description: m.settings_api_keys_revoke_description(),
                        confirmLabel: m.settings_api_keys_revoke(),
                      })
                    )
                      revoke.mutate(key.id);
                  }}
                >
                  {m.settings_api_keys_revoke()}
                </PendingButton>
              </ListRow>
            ))}
          </ListCard>
        )}
      </Section>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent showCloseButton={false}>
          {creating ? <CreateKey onCreated={refresh} /> : null}
        </DialogContent>
      </Dialog>
    </Page>
  );
}

function CreateKey({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ReadonlyArray<McpScope>>(READ_SCOPES);
  const [lifetime, setLifetime] = useState("90");
  const LIFETIMES = lifetimes();
  const create = useMutation({
    // Not kept once the dialog closes: the secret is shown once.
    gcTime: 0,
    mutationFn: () =>
      createApiKey({
        data: {
          name: name.trim(),
          scopes: [...scopes],
          lifetimeDays: LIFETIMES.find((option) => option.value === lifetime)!.days,
        },
      }),
    onSuccess: onCreated,
    onError: (error) => toastError(m.settings_api_keys_error_create(), error),
  });

  if (create.data) return <Reveal secret={create.data.secret} />;
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (!create.isPending) create.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>{m.settings_api_keys_create_title()}</DialogTitle>
        <DialogDescription>{m.settings_api_keys_create_description()}</DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor="api-key-name">{m.common_name()}</FieldLabel>
        <Input
          id="api-key-name"
          value={name}
          maxLength={60}
          placeholder={m.settings_api_keys_name_placeholder()}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <ScopePicker
        idPrefix="api-key"
        scopes={MCP_SCOPES}
        picked={scopes}
        onChange={setScopes}
        disabled={create.isPending}
      />
      <Field>
        <FieldLabel htmlFor="api-key-lifetime">{m.settings_api_keys_lifetime()}</FieldLabel>
        <Select
          value={lifetime}
          onValueChange={(value) => value && setLifetime(value)}
          items={LIFETIMES.map(({ value, label }) => ({ value, label }))}
        >
          <SelectTrigger id="api-key-lifetime" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LIFETIMES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" disabled={create.isPending} />}>
          {m.common_cancel()}
        </DialogClose>
        <PendingButton
          type="submit"
          pending={create.isPending}
          disabled={!name.trim() || scopes.length === 0}
        >
          {m.settings_api_keys_create()}
        </PendingButton>
      </DialogFooter>
    </form>
  );
}

function Reveal({ secret }: { secret: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{m.settings_api_keys_reveal_title()}</DialogTitle>
        <DialogDescription>{m.settings_api_keys_reveal_description()}</DialogDescription>
      </DialogHeader>
      {/* Wrapped whole rather than cut: every character of it is needed. */}
      <code className="bg-muted rounded-2xl px-4 py-3 font-mono text-sm break-all select-all">
        {secret}
      </code>
      <DialogFooter>
        <Button
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(secret).then(() => {
              clearTimeout(timer.current);
              setCopied(true);
              timer.current = setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} strokeWidth={2} />
          {copied ? m.common_copied() : m.settings_api_keys_copy()}
        </Button>
        <DialogClose render={<Button />}>{m.common_done()}</DialogClose>
      </DialogFooter>
    </>
  );
}
