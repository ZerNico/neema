import { Delete02Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useConfirm } from "~/ui/confirm-context.ts";
import { readServerError } from "~/server-error.ts";
import { toastError } from "~/ui/error-toast.ts";
import { OptionalMark } from "~/ui/form/form-fields.tsx";
import { ListRow } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import {
  SortableHandle,
  SortableItem,
  SortableList,
  SortableMoveButtons,
} from "~/ui/sortable-list.tsx";
import { moveId } from "~/ui/move-id.ts";
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
import { cn } from "~/ui/utils";
import { SEARCH_PROVIDER_KINDS, type SearchProviderKind } from "../schema.ts";
import {
  createSearchProvider,
  deleteSearchProvider,
  listSearchProviders,
  setSearchProviderOrder,
  testSearchProvider,
  updateSearchProvider,
} from "../server/functions.ts";
import { searchProvidersQuery } from "../client/queries.ts";
import { m } from "~/paraglide/messages.js";
import { formatLocale } from "~/i18n/formats.ts";

type Provider = Awaited<ReturnType<typeof listSearchProviders>>[number];
type TestResult =
  | { ok: true; resultCount: number; latencyMs: number }
  | { ok: false; error: string };

// Free tiers change too often to quote here; the link is where to check.
const KINDS: Record<SearchProviderKind, { label: string; keyUrl?: string; note?: () => string }> = {
  searxng: { label: "SearXNG", note: m.tools_providers_note_searxng },
  tavily: { label: "Tavily", keyUrl: "https://app.tavily.com" },
  brave: {
    label: "Brave Search",
    keyUrl: "https://api-dashboard.search.brave.com",
    note: m.tools_providers_note_brave,
  },
  exa: { label: "Exa", keyUrl: "https://dashboard.exa.ai" },
  serper: { label: "Serper", keyUrl: "https://serper.dev" },
  jina: { label: "Jina", keyUrl: "https://jina.ai" },
  langsearch: { label: "LangSearch", keyUrl: "https://langsearch.com" },
};
const kindItems = SEARCH_PROVIDER_KINDS.map((kind) => ({ value: kind, label: KINDS[kind].label }));

const REASONS = {
  auth: m.tools_providers_reason_auth,
  quota: m.tools_providers_reason_quota,
  rate_limited: m.tools_providers_reason_rate_limited,
  unavailable: m.tools_providers_reason_unavailable,
  rejected: m.tools_providers_reason_rejected,
} as const;

const clock = (at: number) =>
  new Date(at).toLocaleTimeString(formatLocale(), { hour: "2-digit", minute: "2-digit" });

/** What this server last saw of a provider, in a few words. */
const statusOf = (provider: Provider) => {
  if (!provider.enabled) return m.tools_providers_status_off();
  if (provider.coolingDownUntil && provider.lastError)
    return m.tools_providers_status_cooling({
      reason: REASONS[provider.lastError.reason](),
      time: clock(provider.coolingDownUntil),
    });
  return null;
};

/**
 * The ordered provider list inside the web search card. Every query starts at
 * the top and moves down only when a provider fails; one that keeps failing
 * is tried last until it recovers.
 */
export function SearchProviderRows({ onChanged }: { onChanged: () => Promise<unknown> }) {
  const { data: providers } = useSuspenseQuery(searchProvidersQuery);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Provider | "new" | null>(null);
  // The order last chosen, shown until its save settles and the refetch lands.
  const [draft, setDraft] = useState<string[] | null>(null);
  const order = (draft ?? providers.map((provider) => provider.id))
    .map((id) => providers.find((provider) => provider.id === id))
    .filter((provider) => provider !== undefined);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin", "tools"] }),
      onChanged(),
    ]);
  };
  const mutationKey = ["admin", "save-search-provider-order"];
  const reorder = useMutation({
    mutationKey,
    scope: { id: mutationKey.join(":") },
    mutationFn: (ids: string[]) => setSearchProviderOrder({ data: { ids } }),
    onError: (error) => toastError(m.tools_providers_error_order(), error),
    onSettled: async () => {
      if (queryClient.isMutating({ mutationKey }) > 1) return;
      await refresh();
      setDraft(null);
    },
  });
  const move = (from: number, to: number) => {
    const next = moveId(
      order.map((provider) => provider.id),
      from,
      to,
    );
    setDraft(next);
    reorder.mutate(next);
  };
  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) => updateSearchProvider({ data: input }),
    onSuccess: refresh,
    onError: (error) => toastError(m.tools_providers_error_update(), error),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteSearchProvider({ data: { id } }),
    onSuccess: refresh,
    onError: (error) => toastError(m.tools_providers_error_remove(), error),
  });

  return (
    <>
      <ListRow className="flex-col items-stretch gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-medium">{m.tools_providers_title()}</span>
            <span className="text-muted-foreground text-xs">{m.tools_providers_description()}</span>
          </div>
          <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
            {m.tools_providers_add()}
          </Button>
        </div>
        {order.length === 0 ? (
          <p className="text-muted-foreground text-sm">{m.tools_providers_empty()}</p>
        ) : (
          <SortableList onMove={move} className="divide-y overflow-hidden rounded-md border">
            {order.map((provider, index) => {
              const status = statusOf(provider);
              return (
                <SortableItem
                  key={provider.id}
                  id={provider.id}
                  index={index}
                  className="flex items-center gap-3 py-2 pr-3 pl-1.5"
                >
                  <SortableHandle label={provider.label} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium" title={provider.label}>
                      {provider.label}
                    </span>
                    <span
                      className={cn(
                        "truncate text-xs",
                        provider.coolingDownUntil ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {KINDS[provider.settings.kind].label}
                      {status ? ` · ${status}` : ""}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <SortableMoveButtons
                      label={provider.label}
                      index={index}
                      count={order.length}
                      onMove={move}
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={m.tools_providers_edit_label({ name: provider.label })}
                      onClick={() => setEditing(provider)}
                    >
                      <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={m.tools_providers_remove_label({ name: provider.label })}
                      onClick={async () => {
                        const confirmed = await confirm({
                          title: m.tools_providers_remove_title({ name: provider.label }),
                          description: m.tools_providers_remove_description(),
                          confirmLabel: m.common_remove(),
                        });
                        if (confirmed) remove.mutate(provider.id);
                      }}
                    >
                      <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                    </Button>
                    <Switch
                      checked={provider.enabled}
                      onCheckedChange={(enabled) => toggle.mutate({ id: provider.id, enabled })}
                      disabled={toggle.isPending}
                      aria-label={m.tools_providers_toggle({ name: provider.label })}
                    />
                  </div>
                </SortableItem>
              );
            })}
          </SortableList>
        )}
      </ListRow>
      {editing ? (
        <SearchProviderDialog
          key={editing === "new" ? "new" : editing.id}
          provider={editing === "new" ? null : editing}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSaved={refresh}
        />
      ) : null}
    </>
  );
}

interface Draft {
  kind: SearchProviderKind;
  label: string;
  baseUrl: string;
  secret: string;
}

const settingsOf = (draft: Draft) =>
  draft.kind === "searxng"
    ? { kind: "searxng" as const, baseUrl: draft.baseUrl.trim() }
    : { kind: draft.kind };

/** "Get a key at host." with the host as a link, wherever the sentence puts it. */
function KeyLink({ url }: { url: string }) {
  const mark = "\u0000";
  const [before = "", after = ""] = m.tools_providers_get_key({ host: mark }).split(mark);
  return (
    <>
      {before}
      <a href={url} target="_blank" rel="noreferrer">
        {new URL(url).host}
      </a>
      {after}{" "}
    </>
  );
}

/** Add and edit are one dialog; only the kind is fixed once saved. */
function SearchProviderDialog({
  provider,
  open,
  onOpenChange,
  onSaved,
}: {
  /** Null when adding. */
  provider: Provider | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<unknown>;
}) {
  const fieldId = useId();
  const [draft, setDraft] = useState<Draft>(() => ({
    kind: provider?.settings.kind ?? "searxng",
    label: provider?.label ?? KINDS.searxng.label,
    baseUrl: provider?.settings.kind === "searxng" ? provider.settings.baseUrl : "",
    secret: "",
  }));
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const patch = (next: Partial<Draft>) => {
    setTestResult(null);
    setDraft((current) => ({ ...current, ...next }));
  };
  const kind = KINDS[draft.kind];
  const hosted = draft.kind !== "searxng";
  const complete = Boolean(
    draft.label.trim() &&
    (hosted ? draft.secret.trim() || provider?.secretConfigured : draft.baseUrl.trim()),
  );

  const save = useMutation({
    mutationFn: () => {
      const secret = draft.secret.trim();
      return provider
        ? updateSearchProvider({
            data: {
              id: provider.id,
              label: draft.label.trim(),
              settings: settingsOf(draft),
              ...(secret ? { secret } : {}),
            },
          })
        : createSearchProvider({
            data: {
              label: draft.label.trim(),
              settings: settingsOf(draft),
              ...(secret ? { secret } : {}),
            },
          });
    },
    onSuccess: async () => {
      await onSaved();
      onOpenChange(false);
    },
    onError: (failure) =>
      setError(readServerError(failure).reason ?? m.tools_providers_error_save()),
  });
  const clearSecret = useMutation({
    mutationFn: () => updateSearchProvider({ data: { id: provider!.id, clearSecret: true } }),
    onSuccess: async () => {
      await onSaved();
      onOpenChange(false);
    },
    onError: (failure) => toastError(m.tools_providers_error_clear(), failure),
  });
  const test = useMutation({
    mutationFn: () => {
      const secret = draft.secret.trim();
      return testSearchProvider({
        data: {
          ...(provider ? { id: provider.id } : {}),
          settings: settingsOf(draft),
          ...(secret ? { secret } : {}),
        },
      });
    },
    onSuccess: setTestResult,
    onError: (failure) => toastError(m.tools_providers_error_test(), failure),
  });
  const busy = save.isPending || clearSecret.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {provider
              ? m.tools_providers_dialog_edit_title({ name: provider.label })
              : m.tools_providers_dialog_add_title()}
          </DialogTitle>
          <DialogDescription>{m.tools_providers_dialog_description()}</DialogDescription>
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
                <FieldLabel htmlFor={`${fieldId}-kind`}>{m.tools_providers_kind()}</FieldLabel>
                <Select
                  value={draft.kind}
                  onValueChange={(next) => {
                    if (!next) return;
                    const changed = next as SearchProviderKind;
                    // Keep a label the admin typed; replace one that only named the old kind.
                    const label =
                      draft.label === KINDS[draft.kind].label ? KINDS[changed].label : draft.label;
                    patch({ kind: changed, label });
                  }}
                  items={kindItems}
                  disabled={busy}
                >
                  <SelectTrigger id={`${fieldId}-kind`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {kindItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor={`${fieldId}-label`}>{m.common_name()}</FieldLabel>
              <Input
                id={`${fieldId}-label`}
                value={draft.label}
                onChange={(event) => patch({ label: event.target.value })}
                disabled={busy}
              />
              <FieldDescription>{m.tools_providers_name_description()}</FieldDescription>
            </Field>
            {hosted ? null : (
              <Field>
                <FieldLabel htmlFor={`${fieldId}-url`}>{m.tools_providers_base_url()}</FieldLabel>
                <Input
                  id={`${fieldId}-url`}
                  type="url"
                  // oxlint-disable-next-line i18n/no-literal-text -- an example address
                  placeholder="http://localhost:8081"
                  value={draft.baseUrl}
                  onChange={(event) => patch({ baseUrl: event.target.value })}
                  disabled={busy}
                />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor={`${fieldId}-secret`}>
                {hosted ? (
                  m.tools_providers_api_key()
                ) : (
                  <>
                    {m.tools_providers_bearer_token()} <OptionalMark />
                  </>
                )}
              </FieldLabel>
              <div className="flex gap-2">
                <Input
                  id={`${fieldId}-secret`}
                  type="password"
                  autoComplete="off"
                  placeholder={
                    provider?.secretConfigured ? m.tools_providers_secret_unchanged() : undefined
                  }
                  value={draft.secret}
                  onChange={(event) => patch({ secret: event.target.value })}
                  disabled={busy}
                  className="flex-1"
                />
                {!hosted && provider?.secretConfigured ? (
                  <PendingButton
                    size="sm"
                    variant="outline"
                    pending={clearSecret.isPending}
                    disabled={save.isPending}
                    onClick={() => clearSecret.mutate()}
                  >
                    {m.tools_providers_clear_secret()}
                  </PendingButton>
                ) : null}
              </div>
              {provider?.secretConfigured || kind.keyUrl || kind.note ? (
                <FieldDescription>
                  {provider?.secretConfigured ? `${m.tools_providers_keep_secret()} ` : ""}
                  {kind.keyUrl ? <KeyLink url={kind.keyUrl} /> : null}
                  {kind.note?.() ?? ""}
                </FieldDescription>
              ) : null}
            </Field>
          </FieldGroup>
          {testResult ? (
            <p
              role="status"
              className={cn("text-xs", testResult.ok ? "text-success" : "text-destructive")}
            >
              {testResult.ok
                ? m.tools_providers_test_works({
                    count: testResult.resultCount,
                    latency: testResult.latencyMs,
                  })
                : m.tools_providers_test_failed({ error: testResult.error })}
            </p>
          ) : null}
          {error ? <FieldError>{error}</FieldError> : null}
          <DialogFooter>
            <PendingButton
              variant="outline"
              pending={test.isPending}
              disabled={!complete || busy}
              onClick={() => {
                setTestResult(null);
                test.mutate();
              }}
            >
              {m.tools_providers_test()}
            </PendingButton>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>
              {m.common_cancel()}
            </DialogClose>
            <PendingButton type="submit" pending={save.isPending} disabled={!complete || busy}>
              {provider ? m.common_save() : m.tools_providers_dialog_add()}
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
