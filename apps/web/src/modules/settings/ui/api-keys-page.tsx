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

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const when = (value: Date | string) => dateFormat.format(new Date(value));

const LIFETIMES: ReadonlyArray<{ value: string; label: string; days: ApiKeyLifetime }> = [
  ...API_KEY_DAYS.map((days) => ({
    value: String(days),
    label: days === 365 ? "1 year" : `${days} days`,
    days,
  })),
  { value: "never", label: "Never expires", days: null },
];

const READ_SCOPES = MCP_SCOPES.filter((scope) => !scope.endsWith(":write"));

const lifeLine = (key: ApiKeySummary) => {
  if (!key.expiresAt) return "Never expires";
  return new Date(key.expiresAt) <= new Date()
    ? `Expired ${when(key.expiresAt)}`
    : `Expires ${when(key.expiresAt)}`;
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
    onError: (error) => toastError("Could not revoke the key.", error),
  });

  return (
    <Page
      title="API keys"
      description="For scripts and services that can’t sign in through a browser. A key acts as you, with what you let it do."
      rootPath="/settings"
      rootLabel="Settings"
    >
      <Section
        title="Keys"
        actions={
          data.allowed && data.serverUrl ? (
            <Button variant="outline" onClick={() => setCreating(true)}>
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
              New key
            </Button>
          ) : null
        }
      >
        {data.allowed ? null : (
          <p className="text-muted-foreground text-sm">
            Your account can’t make API keys. Ask an admin.
          </p>
        )}
        {data.keys.length === 0 ? (
          <EmptyState icon={Key01Icon} title="No API keys" />
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
                    {key.lastUsedAt ? `Last used ${when(key.lastUsedAt)}` : "Never used"}
                  </span>
                </div>
                <PendingButton
                  variant="ghost"
                  size="sm"
                  pending={revoke.isPending && revoke.variables === key.id}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Revoke ${key.name}?`,
                        description: "Anything using it loses access at once.",
                        confirmLabel: "Revoke",
                      })
                    )
                      revoke.mutate(key.id);
                  }}
                >
                  Revoke
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
    onError: (error) => toastError("Could not make the key.", error),
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
        <DialogTitle>New API key</DialogTitle>
        <DialogDescription>It can do only what you tick here.</DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor="api-key-name">Name</FieldLabel>
        <Input
          id="api-key-name"
          value={name}
          maxLength={60}
          placeholder="For example: n8n"
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
        <FieldLabel htmlFor="api-key-lifetime">Expires</FieldLabel>
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
          Cancel
        </DialogClose>
        <PendingButton
          type="submit"
          pending={create.isPending}
          disabled={!name.trim() || scopes.length === 0}
        >
          Make key
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
        <DialogTitle>Copy your key</DialogTitle>
        <DialogDescription>
          You won’t see it again. Send it as a bearer token in the Authorization header.
        </DialogDescription>
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
          {copied ? "Copied" : "Copy key"}
        </Button>
        <DialogClose render={<Button />}>Done</DialogClose>
      </DialogFooter>
    </>
  );
}
