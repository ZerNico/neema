import { RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { absoluteLabel } from "~/modules/chat/ui/timestamps.ts";
import { ActivityChevron } from "~/modules/chat/ui/activity-face.tsx";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "~/ui/disclosure.tsx";
import { disclosureTriggerClassName } from "~/ui/disclosure-classes.ts";
import { EmptyState, ListCard, ListRow } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Badge } from "~/ui/primitives/badge";
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
import { FieldError } from "~/ui/primitives/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { Switch } from "~/ui/primitives/switch";
import { PlugSocketIcon } from "@hugeicons/core-free-icons";
import { adminIntegrationsQuery } from "../client/queries.ts";
import type { ToolAccess } from "../manifest.ts";
import {
  diffCatalog,
  MCP_LIMITS,
  type CatalogChange,
  type McpAnnotations,
  type McpToolEntry,
} from "../mcp/catalog.ts";
import type { AdminCatalog, AdminIntegration } from "../schema.ts";
import { approveIntegrationCatalog, checkIntegrationCatalog } from "../server/functions.ts";

const ACCESS: ReadonlyArray<{ value: ToolAccess; label: string }> = [
  { value: "read", label: "Reads only" },
  { value: "write", label: "Changes things" },
  { value: "destructive", label: "Deletes or sends" },
];

/** What the server claims, which is a hint until the admin agrees with it. */
const hint = (annotations: McpAnnotations) =>
  annotations.readOnlyHint
    ? "The server says it only reads."
    : annotations.destructiveHint === false
      ? "The server says it changes things but never deletes."
      : annotations.destructiveHint
        ? "The server says it can delete or send."
        : "The server says nothing, so it counts as able to delete or send.";

type Decision = { enabled: boolean; access: ToolAccess };

/** Where a review starts: each tool as approved before, a new one off at what it claims. */
const initialDecisions = (changes: ReadonlyArray<CatalogChange>) => {
  const decisions = new Map<string, Decision>();
  for (const change of changes) {
    if (change.kind === "removed") continue;
    const before = change.kind === "added" ? null : change.before;
    decisions.set(change.entry.mcpName, {
      enabled: !change.entry.unsupported && (before?.enabled ?? false),
      access: before?.accessChosen ? before.access : change.entry.access,
    });
  }
  return decisions;
};

const changedParts = (before: McpToolEntry, after: McpToolEntry) =>
  [
    before.description !== after.description ? "description" : null,
    JSON.stringify(before.inputSchema) !== JSON.stringify(after.inputSchema) ? "arguments" : null,
    JSON.stringify(before.outputSchema) !== JSON.stringify(after.outputSchema) ? "results" : null,
    JSON.stringify(before.annotations) !== JSON.stringify(after.annotations) ? "hints" : null,
    before.title !== after.title ? "name" : null,
  ].filter(Boolean);

/**
 * The admin's review of what an MCP server lists. Nothing a server says
 * reaches a chat until it is approved here; a tool new or changed since the
 * last approval is marked and stays off chats until approved again.
 */
export function McpToolsReview({
  row,
  onOpenChange,
}: {
  row: AdminIntegration;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [catalog, setCatalog] = useState<AdminCatalog>(row.catalog!);
  const changes = useMemo(
    () => diffCatalog(catalog.approved, catalog.latest),
    [catalog.approved, catalog.latest],
  );
  const [decisions, setDecisions] = useState(() => initialDecisions(changes));
  const [error, setError] = useState<string | null>(catalog.checkError);

  const refresh = (next: AdminCatalog) => {
    setCatalog(next);
    setDecisions(initialDecisions(diffCatalog(next.approved, next.latest)));
    setError(next.checkError);
    void queryClient.invalidateQueries({ queryKey: adminIntegrationsQuery.queryKey });
  };
  const check = useMutation({
    mutationFn: () => checkIntegrationCatalog({ data: { integrationId: row.id } }),
    onSuccess: (result) => (result.ok ? refresh(result.catalog) : setError(result.error)),
    onError: () => setError(`Could not reach ${row.name}.`),
  });
  const approve = useMutation({
    mutationFn: () =>
      approveIntegrationCatalog({
        data: {
          integrationId: row.id,
          fingerprint: catalog.version ?? "",
          decisions: [...decisions].map(([mcpName, decision]) => ({ mcpName, ...decision })),
        },
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      refresh(result.catalog);
      onOpenChange(false);
    },
    onError: () => setError("Could not save the review."),
  });

  // Never listed: look now rather than show an empty dialog with a button to press.
  const neverChecked = row.catalog?.latest === null && !row.catalog?.checkError;
  const { mutate: checkNow } = check;
  useEffect(() => {
    if (neverChecked) checkNow();
  }, [neverChecked, checkNow]);

  const pending = changes.filter((change) => change.kind !== "unchanged").length;
  const enabled = [...decisions.values()].filter((decision) => decision.enabled).length;
  const busy = check.isPending || approve.isPending;
  const server = catalog.server;
  const serverLine = [
    server?.title || server?.name,
    server?.version ? `v${server.version}` : null,
    server?.protocol ? `protocol ${server.protocol}` : null,
    catalog.checkedAt ? `checked ${absoluteLabel(new Date(catalog.checkedAt))}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const decide = (mcpName: string, patch: Partial<Decision>) =>
    setDecisions((current) => {
      const next = new Map(current);
      next.set(mcpName, { ...next.get(mcpName)!, ...patch });
      return next;
    });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{row.name} tools</DialogTitle>
          <DialogDescription>
            Chats get only the tools you turn on here, described as you saw them. When the server
            changes one, it waits for you again.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-3">
          <p className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
            {serverLine || "Not checked yet"}
          </p>
          <PendingButton
            size="sm"
            variant="outline"
            pending={check.isPending}
            disabled={approve.isPending}
            onClick={() => check.mutate()}
          >
            <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
            Check now
          </PendingButton>
        </div>
        {error ? <FieldError>{error}</FieldError> : null}
        {catalog.latest === null ? (
          <EmptyState
            icon={PlugSocketIcon}
            title={check.isPending ? "Asking the server…" : "No tools listed yet"}
            description={
              check.isPending ? "This takes a moment." : "Check the server to see what it offers."
            }
          />
        ) : changes.length === 0 ? (
          <EmptyState
            icon={PlugSocketIcon}
            title="The server lists no tools"
            description="Check again once it does."
          />
        ) : (
          <ListCard>
            {changes.map((change) =>
              change.kind === "removed" ? (
                <ListRow key={`removed-${change.before.mcpName}`}>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-muted-foreground flex items-center gap-2 text-sm line-through">
                      {change.before.title}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      The server no longer lists it, so chats no longer get it.
                    </span>
                  </div>
                  <Badge variant="outline">Removed</Badge>
                </ListRow>
              ) : (
                <ToolRow
                  key={change.entry.mcpName}
                  change={change}
                  decision={decisions.get(change.entry.mcpName)!}
                  disabled={busy}
                  onChange={(patch) => decide(change.entry.mcpName, patch)}
                />
              ),
            )}
          </ListCard>
        )}
        <DialogFooter>
          <p className="text-muted-foreground mr-auto self-center text-xs tabular-nums">
            {enabled} of {MCP_LIMITS.enabledTools} on
            {pending ? ` · ${pending} to review` : ""}
          </p>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</DialogClose>
          <PendingButton
            pending={approve.isPending}
            disabled={check.isPending || !catalog.version || enabled > MCP_LIMITS.enabledTools}
            onClick={() => approve.mutate()}
          >
            Approve
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ToolRow({
  change,
  decision,
  disabled,
  onChange,
}: {
  change: Exclude<CatalogChange, { kind: "removed" }>;
  decision: Decision;
  disabled: boolean;
  onChange: (patch: Partial<Decision>) => void;
}) {
  const [open, setOpen] = useState(false);
  const { entry } = change;
  const changed = change.kind === "changed" ? changedParts(change.before, entry) : [];
  return (
    <ListRow className="flex-col items-stretch gap-2">
      <div className="flex min-w-0 items-start gap-3">
        <Switch
          checked={decision.enabled}
          disabled={disabled || Boolean(entry.unsupported)}
          aria-label={`Offer ${entry.title}`}
          onCheckedChange={(enabled) => onChange({ enabled })}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium">
            <span className="truncate">{entry.title}</span>
            {change.kind === "added" ? <Badge variant="secondary">New</Badge> : null}
            {change.kind === "changed" ? <Badge variant="secondary">Changed</Badge> : null}
            {entry.unsupported ? <Badge variant="destructive">Can’t offer</Badge> : null}
          </span>
          <span className="text-muted-foreground font-mono text-xs [overflow-wrap:anywhere]">
            {entry.mcpName}
          </span>
        </div>
        <Select
          value={decision.access}
          items={ACCESS}
          disabled={disabled || Boolean(entry.unsupported)}
          onValueChange={(value) => onChange({ access: value as ToolAccess })}
        >
          <SelectTrigger size="sm" aria-label={`What ${entry.title} can do`} className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACCESS.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Disclosure open={open} onOpenChange={setOpen}>
        <div className="pl-11">
          <DisclosureTrigger className={disclosureTriggerClassName}>
            <span className="text-xs">
              {entry.unsupported
                ? entry.unsupported
                : changed.length
                  ? `Changed: ${changed.join(", ")}. Show what the model would read`
                  : "Show what the model would read"}
            </span>
            <ActivityChevron open={open} />
          </DisclosureTrigger>
        </div>
        <DisclosureContent>
          <div className="flex flex-col gap-2 pt-2 pl-11 text-xs">
            <p className="text-muted-foreground">{hint(entry.annotations)}</p>
            <p className="[overflow-wrap:anywhere] whitespace-pre-wrap">
              {entry.description || "No description."}
            </p>
            {change.kind === "changed" && change.before.description !== entry.description ? (
              <p className="text-muted-foreground [overflow-wrap:anywhere] whitespace-pre-wrap line-through">
                {change.before.description || "No description."}
              </p>
            ) : null}
            <pre className="bg-muted max-h-48 overflow-auto rounded-xl p-2 font-mono text-[11px]">
              {JSON.stringify(entry.inputSchema, null, 2)}
            </pre>
          </div>
        </DisclosureContent>
      </Disclosure>
    </ListRow>
  );
}
