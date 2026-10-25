import { getLocale } from "~/paraglide/runtime.js";
import { m } from "~/paraglide/messages.js";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Delete02Icon,
  PencilEdit02Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { searchState, type KnowledgeDocument } from "~/modules/knowledge/schema.ts";
import { rebuildKnowledgeIndex } from "~/modules/knowledge/server/functions.ts";
import { useConfirm } from "~/ui/confirm-context.ts";
import { useDetailPanel } from "~/ui/detail-panel-context.ts";
import { toastError } from "~/ui/error-toast.ts";
import { ListCard, ListRow, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Checkbox } from "~/ui/primitives/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Field, FieldError, FieldLabel } from "~/ui/primitives/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { Spinner } from "~/ui/primitives/spinner";
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";
import { cn } from "~/ui/utils";
import { knowledgeSourcesQuery } from "../client/queries.ts";
import {
  accountName,
  type BrowseNode,
  type IntegrationConnectionView,
  type KnowledgeSourceView,
  type SourceRoot,
  type SourceRule,
} from "../schema.ts";
import { useSyncableIntegrations } from "../client/use-syncable-integrations.ts";
import {
  browseIntegration,
  removeKnowledgeSource,
  saveKnowledgeSource,
  syncKnowledgeSource,
} from "../server/functions.ts";
import { IntegrationLogo } from "./integration-logo.tsx";
import { useIntegrationDirectory } from "../client/directory.ts";
import { openSyncedPages } from "./open-synced-pages.tsx";

/**
 * What the picker works on: a new source for an integration, or an existing
 * one, and the account it syncs as; null when that account was disconnected.
 */
export type SourceTarget = {
  integrationId: string;
  connectionId: string | null;
  sourceId?: string;
};

const selectionSummary = (root: SourceRoot) => {
  const includes = root.rules.filter((rule) => rule.mode === "include").length;
  const excludes = root.rules.filter((rule) => rule.mode === "exclude").length;
  if (root.mode === "all")
    return excludes
      ? m.integrations_sources_everything_except({
          pages: m.integrations_sources_pages({ count: excludes }),
        })
      : m.integrations_sources_everything();
  return excludes
    ? m.integrations_sources_picked_excluded({ count: includes, excluded: excludes })
    : m.integrations_sources_picked({ count: includes });
};

/**
 * Where a collection's mirrored documents come from, one row per source.
 * Owner only: each sync runs with the owner's own connection. Adding one
 * lives in the page's Add menu.
 */
export function KnowledgeSourcesSection({
  collectionId,
  documents,
  onEdit,
}: {
  collectionId: string;
  /** The collection's synced documents, grouped here under their source. */
  documents: ReadonlyArray<KnowledgeDocument>;
  onEdit: (target: SourceTarget) => void;
}) {
  const sources = useQuery(knowledgeSourcesQuery(collectionId));
  const list = sources.data ?? [];
  if (list.length === 0) return null;
  return (
    <Section title={m.integrations_sources_title()}>
      <ListCard>
        {list.map((source) => (
          <SourceRow
            key={source.id}
            source={source}
            documents={documents.filter((document) => document.source?.sourceId === source.id)}
            onEdit={() =>
              onEdit({
                integrationId: source.integrationId,
                connectionId: source.connectionId,
                sourceId: source.id,
              })
            }
          />
        ))}
      </ListCard>
    </Section>
  );
}

function SourceRow({
  source,
  documents,
  onEdit,
}: {
  source: KnowledgeSourceView;
  documents: ReadonlyArray<KnowledgeDocument>;
  onEdit: () => void;
}) {
  const panel = useDetailPanel();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const name = useIntegrationDirectory().name(source.integrationId);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["knowledge"] });
  const sync = useMutation({
    mutationFn: () => syncKnowledgeSource({ data: { sourceId: source.id } }),
    onSuccess: refresh,
    onError: (error) => toastError(m.integrations_sources_sync_error(), error),
  });
  const remove = useMutation({
    mutationFn: () => removeKnowledgeSource({ data: { sourceId: source.id } }),
    onSuccess: refresh,
    onError: (error) => toastError(m.integrations_sources_remove_error(), error),
  });
  const preparing = documents.filter(
    (document) =>
      document.status === "queued" ||
      document.status === "extracting" ||
      document.replacement?.status === "queued" ||
      document.replacement?.status === "extracting",
  ).length;
  const failed = documents.filter(
    (document) => document.status === "failed" || document.replacement?.status === "failed",
  ).length;
  const preparingSearch = documents.filter(
    (document) => searchState(document) === "preparing",
  ).length;
  const basicSearch = documents.filter((document) => searchState(document) === "basic").length;
  // Re-queues only embeddings that failed or are out of date; the rest stay.
  const retrySearch = useMutation({
    mutationFn: () => rebuildKnowledgeIndex({ data: { collectionId: source.collectionId } }),
    onSuccess: async ({ reembedded }) => {
      await refresh();
      toast.success(
        reembedded === 0
          ? m.integrations_sources_retry_nothing()
          : m.integrations_sources_retry_started({ count: reembedded }),
      );
    },
    onError: (error) => toastError(m.integrations_sources_retry_error(), error),
  });
  const status = !source.connected
    ? source.canEdit
      ? m.integrations_sources_paused_own({ name })
      : m.integrations_sources_paused_owner({ name })
    : (source.lastError ??
      [
        selectionSummary(source.root),
        preparing ? m.integrations_sources_preparing({ count: preparing }) : null,
        failed ? m.integrations_sources_failed({ count: failed }) : null,
        preparingSearch
          ? m.integrations_sources_preparing_search({ count: preparingSearch })
          : null,
        basicSearch ? m.integrations_sources_basic_search({ count: basicSearch }) : null,
        source.stats?.elsewhere
          ? m.integrations_sources_elsewhere({ count: source.stats.elsewhere })
          : null,
        source.stats?.tooLarge
          ? m.integrations_sources_too_large({ count: source.stats.tooLarge })
          : null,
        source.stats?.overLimit
          ? m.integrations_sources_over_limit({ count: source.stats.overLimit })
          : null,
        source.lastSyncedAt
          ? m.integrations_sources_synced_at({
              date: new Intl.DateTimeFormat(getLocale(), {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(source.lastSyncedAt)),
            })
          : m.integrations_sources_not_synced(),
      ]
        .filter(Boolean)
        .join(" · "));

  return (
    <ListRow className="flex-wrap">
      <IntegrationLogo integrationId={source.integrationId} variant="tile" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 text-sm font-medium">
          <span className="min-w-0 truncate">{source.root.title}</span>
          {source.status === "syncing" ? (
            <Badge variant="secondary">{m.integrations_sources_syncing()}</Badge>
          ) : null}
          {source.status === "error" || !source.connected ? (
            <Badge variant="destructive">{m.integrations_sources_attention()}</Badge>
          ) : null}
        </span>
        <span className="text-muted-foreground text-xs">{status}</span>
      </div>
      {source.canEdit && basicSearch > 0 ? (
        <PendingButton
          size="sm"
          variant="outline"
          pending={retrySearch.isPending}
          onClick={() => retrySearch.mutate()}
        >
          {m.integrations_sources_retry_failed()}
        </PendingButton>
      ) : null}
      {documents.length ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => openSyncedPages(panel, source.collectionId, source.id, source.root.title)}
        >
          {m.integrations_sources_pages({ count: documents.length })}
        </Button>
      ) : null}
      {source.canEdit ? (
        <>
          {source.connected ? (
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={m.integrations_sources_edit_label({ title: source.root.title })}
                onClick={onEdit}
              >
                <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
              </Button>
              <PendingButton
                size="icon-sm"
                variant="ghost"
                aria-label={m.integrations_sources_sync_now_label({ title: source.root.title })}
                pending={sync.isPending}
                disabled={source.status === "syncing"}
                onClick={() => sync.mutate()}
              >
                <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
              </PendingButton>
            </>
          ) : (
            // Syncing resumes by itself once the owner connects again.
            <Button
              size="sm"
              variant="outline"
              render={
                <Link
                  to="/settings/integrations/$integrationId"
                  params={{ integrationId: source.integrationId }}
                />
              }
            >
              {m.integrations_sources_reconnect({ name })}
            </Button>
          )}
          <PendingButton
            size="icon-sm"
            variant="ghost"
            aria-label={m.integrations_sources_stop_label({ title: source.root.title })}
            pending={remove.isPending}
            onClick={async () => {
              if (
                await confirm({
                  title: m.integrations_sources_stop_title({ title: source.root.title }),
                  description: m.integrations_sources_stop_description({ name }),
                  confirmLabel: m.integrations_sources_stop(),
                })
              )
                remove.mutate();
            }}
          >
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
          </PendingButton>
        </>
      ) : null}
    </ListRow>
  );
}

/** Nearest rule on the path below the root, else the root's own default. */
const effective = (
  path: ReadonlyArray<string>,
  rules: ReadonlyMap<string, SourceRule>,
  fallback: boolean,
) => {
  for (let index = path.length - 1; index >= 0; index--) {
    const rule = rules.get(path[index]!);
    if (rule) return rule.mode === "include";
  }
  return fallback;
};

interface DraftRoot {
  nodeId: string;
  title: string;
  hasChildren: boolean;
  mode: SourceRoot["mode"];
  rules: ReadonlyMap<string, SourceRule>;
}

/**
 * Adds a source, or edits one: first where to sync from (a collection or any
 * page in it), then everything under it with some pages left out, or only
 * the pages picked. Pages added later follow the choice above them.
 */
export function SourcePickerDialog({
  collectionId,
  target,
  open,
  onOpenChange,
}: {
  collectionId: string;
  target: SourceTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const sources = useQuery(knowledgeSourcesQuery(collectionId));
  const accounts =
    useSyncableIntegrations().find((integration) => integration.id === target.integrationId)
      ?.connections ?? [];
  if (sources.isPending) return null;
  const existing = target.sourceId
    ? sources.data?.find((source) => source.id === target.sourceId)
    : undefined;
  return (
    <SourcePicker
      collectionId={collectionId}
      integrationId={target.integrationId}
      accounts={accounts}
      // Its own account, else the first working one, which the picker lets them change.
      initialAccount={target.connectionId ?? accounts[0]?.id ?? null}
      sourceId={existing?.id}
      initial={existing?.root ?? null}
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}

function SourcePicker({
  collectionId,
  integrationId,
  accounts,
  initialAccount,
  sourceId,
  initial,
  open,
  onOpenChange,
}: {
  collectionId: string;
  integrationId: string;
  /** The owner's working accounts on it. */
  accounts: ReadonlyArray<IntegrationConnectionView>;
  initialAccount: string | null;
  sourceId: string | undefined;
  initial: SourceRoot | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [root, setRoot] = useState<DraftRoot | null>(() =>
    initial
      ? {
          nodeId: initial.nodeId,
          title: initial.title,
          // Unknown until browsed; an empty level says so itself.
          hasChildren: true,
          mode: initial.mode,
          rules: new Map(initial.rules.map((rule) => [rule.nodeId, rule])),
        }
      : null,
  );
  const [step, setStep] = useState<"where" | "what">(initial ? "what" : "where");
  const [error, setError] = useState<string | null>(null);
  const name = useIntegrationDirectory().name(integrationId);
  const [connectionId, setConnectionId] = useState(initialAccount);
  const save = useMutation({
    mutationFn: (chosen: DraftRoot & { connectionId: string }) =>
      saveKnowledgeSource({
        data: {
          collectionId,
          connectionId: chosen.connectionId,
          ...(sourceId ? { sourceId } : {}),
          root: {
            nodeId: chosen.nodeId,
            title: chosen.title.slice(0, 200),
            mode: chosen.mode,
            rules: [...chosen.rules.values()],
          },
        },
      }),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["knowledge"] });
      onOpenChange(false);
    },
    onError: () => setError(m.integrations_sources_save_error()),
  });

  /**
   * A rule is kept only where a page differs from what it would inherit, so
   * the saved list stays the few choices the person actually made.
   */
  const togglePage = (node: BrowseNode, ancestors: ReadonlyArray<string>) =>
    setRoot((current) => {
      if (!current) return current;
      const fallback = current.mode === "all";
      const rules = new Map(current.rules);
      const now = effective([...ancestors, node.id], rules, fallback);
      rules.delete(node.id);
      if (effective(ancestors, rules, fallback) !== !now)
        rules.set(node.id, {
          nodeId: node.id,
          title: node.title.slice(0, 200),
          mode: now ? "exclude" : "include",
        });
      return { ...current, rules };
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && save.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step === "where" || !root ? m.integrations_sources_dialog_title({ name }) : root.title}
          </DialogTitle>
          <DialogDescription>
            {step === "where"
              ? m.integrations_sources_where_description()
              : m.integrations_sources_what_description()}
          </DialogDescription>
        </DialogHeader>
        {accounts.length > 1 ? (
          <Field>
            <FieldLabel>{m.integrations_sources_sync_as()}</FieldLabel>
            <Select
              value={connectionId ?? ""}
              items={accounts.map((account) => ({
                value: account.id,
                label: accountName(account),
              }))}
              onValueChange={(value) => setConnectionId(String(value))}
            >
              <SelectTrigger aria-label={m.integrations_sources_sync_as_label()}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {accountName(account)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        <div className="max-h-[28rem] min-w-0 overflow-y-auto rounded-2xl border p-2">
          {!connectionId ? (
            <p className="text-muted-foreground p-2 text-sm">
              {m.integrations_sources_connect_first({ name })}
            </p>
          ) : step === "where" || !root ? (
            <ChooseLevel
              connectionId={connectionId}
              parentId={null}
              chosen={root?.nodeId ?? null}
              onChoose={(node) =>
                setRoot((current) =>
                  current?.nodeId === node.id
                    ? current
                    : {
                        nodeId: node.id,
                        title: node.title,
                        hasChildren: node.hasChildren,
                        mode: "all",
                        rules: new Map(),
                      },
                )
              }
            />
          ) : (
            <div className="flex flex-col gap-2 p-1">
              <ToggleGroup
                value={[root.mode]}
                onValueChange={(values) => {
                  const mode = values.at(-1);
                  if (mode === "all" || mode === "selected")
                    setRoot({ ...root, mode, rules: new Map() });
                }}
                variant="outline"
                size="sm"
                spacing={0}
                aria-label={m.integrations_sources_what_label({ title: root.title })}
              >
                <ToggleGroupItem value="all">{m.integrations_sources_mode_all()}</ToggleGroupItem>
                <ToggleGroupItem value="selected">
                  {m.integrations_sources_mode_selected()}
                </ToggleGroupItem>
              </ToggleGroup>
              <p className="text-muted-foreground text-xs">
                {root.mode === "all"
                  ? m.integrations_sources_mode_all_hint()
                  : m.integrations_sources_mode_selected_hint()}
              </p>
              {root.hasChildren ? (
                <PickLevel
                  connectionId={connectionId}
                  parentId={root.nodeId}
                  ancestors={[]}
                  root={root}
                  onToggle={togglePage}
                />
              ) : (
                <p className="text-muted-foreground text-sm">{m.integrations_sources_leaf()}</p>
              )}
            </div>
          )}
        </div>
        {error ? <FieldError>{error}</FieldError> : null}
        <DialogFooter>
          {step === "what" ? (
            <Button
              variant="ghost"
              className="sm:mr-auto"
              disabled={save.isPending}
              onClick={() => setStep("where")}
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} data-icon="inline-start" />
              {m.integrations_sources_change()}
            </Button>
          ) : null}
          <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
            {m.common_cancel()}
          </DialogClose>
          {step === "where" ? (
            <Button disabled={!root} onClick={() => setStep("what")}>
              {m.integrations_sources_next()}
            </Button>
          ) : (
            <PendingButton
              pending={save.isPending}
              disabled={!root}
              onClick={() => root && connectionId && save.mutate({ ...root, connectionId })}
            >
              {sourceId ? m.integrations_sources_save_sync() : m.integrations_sources_start()}
            </PendingButton>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Loads one level of the service's tree; shared by both steps. */
function useBrowseLevel(connectionId: string, parentId: string | null) {
  return useQuery({
    queryKey: ["integration-browse", connectionId, parentId],
    queryFn: () => browseIntegration({ data: { connectionId, ...(parentId ? { parentId } : {}) } }),
    staleTime: 60_000,
  });
}

function LevelState({ level }: { level: ReturnType<typeof useBrowseLevel> }) {
  if (level.isPending)
    return (
      <div className="text-muted-foreground flex items-center gap-2 p-2 text-sm">
        <Spinner /> {m.integrations_sources_loading()}
      </div>
    );
  if (!level.data?.ok)
    return (
      <p className="text-destructive p-2 text-sm">
        {level.data?.ok === false ? level.data.error : m.integrations_sources_level_error()}
      </p>
    );
  return (
    <p className="text-muted-foreground p-2 text-sm">{m.integrations_sources_level_empty()}</p>
  );
}

function ExpandButton({
  node,
  expanded,
  onToggle,
}: {
  node: BrowseNode;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={
        expanded
          ? m.integrations_sources_collapse({ title: node.title })
          : m.integrations_sources_expand({ title: node.title })
      }
      aria-expanded={expanded}
      disabled={!node.hasChildren}
      className={cn(!node.hasChildren && "invisible")}
      onClick={onToggle}
    >
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        strokeWidth={2}
        className={cn("transition-transform", expanded && "rotate-90")}
      />
    </Button>
  );
}

/** Step one: pick the one node to sync from, browsing down as far as needed. */
function ChooseLevel({
  connectionId,
  parentId,
  chosen,
  onChoose,
}: {
  connectionId: string;
  parentId: string | null;
  chosen: string | null;
  onChoose: (node: BrowseNode) => void;
}) {
  const level = useBrowseLevel(connectionId, parentId);
  if (!level.data?.ok || level.data.nodes.length === 0) return <LevelState level={level} />;
  return (
    <ul
      className="flex flex-col"
      role="radiogroup"
      aria-label={m.integrations_sources_where_label()}
    >
      {level.data.nodes.map((node) => (
        <ChooseRow
          key={node.id}
          connectionId={connectionId}
          node={node}
          chosen={chosen}
          onChoose={onChoose}
        />
      ))}
    </ul>
  );
}

function ChooseRow({
  connectionId,
  node,
  chosen,
  onChoose,
}: {
  connectionId: string;
  node: BrowseNode;
  chosen: string | null;
  onChoose: (node: BrowseNode) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const selected = chosen === node.id;
  return (
    <li>
      <div
        className={cn(
          "flex items-center gap-1 rounded-xl px-1 py-0.5",
          selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
        )}
      >
        <ExpandButton node={node} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          className={cn(
            "min-w-0 flex-1 truncate py-1 text-left text-sm",
            node.kind === "container" && "font-medium",
          )}
          onClick={() => onChoose(node)}
        >
          {node.title}
        </button>
      </div>
      {expanded ? (
        <div className="pl-6">
          <ChooseLevel
            connectionId={connectionId}
            parentId={node.id}
            chosen={chosen}
            onChoose={onChoose}
          />
        </div>
      ) : null}
    </li>
  );
}

/** Step two: check or uncheck pages under the chosen node. */
function PickLevel({
  connectionId,
  parentId,
  ancestors,
  root,
  onToggle,
}: {
  connectionId: string;
  parentId: string;
  ancestors: ReadonlyArray<string>;
  root: DraftRoot;
  onToggle: (node: BrowseNode, ancestors: ReadonlyArray<string>) => void;
}) {
  const level = useBrowseLevel(connectionId, parentId);
  if (!level.data?.ok || level.data.nodes.length === 0) return <LevelState level={level} />;
  return (
    <ul className="flex flex-col">
      {level.data.nodes.map((node) => (
        <PickRow
          key={node.id}
          connectionId={connectionId}
          node={node}
          ancestors={ancestors}
          root={root}
          onToggle={onToggle}
        />
      ))}
    </ul>
  );
}

function PickRow({
  connectionId,
  node,
  ancestors,
  root,
  onToggle,
}: {
  connectionId: string;
  node: BrowseNode;
  ancestors: ReadonlyArray<string>;
  root: DraftRoot;
  onToggle: (node: BrowseNode, ancestors: ReadonlyArray<string>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const path = [...ancestors, node.id];
  const checked = effective(path, root.rules, root.mode === "all");
  return (
    <li>
      <div className="hover:bg-muted/60 flex items-center gap-2 rounded-xl px-1 py-1">
        <ExpandButton node={node} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
        <Checkbox
          checked={checked}
          onCheckedChange={() => onToggle(node, ancestors)}
          aria-label={node.title}
        />
        <span className="min-w-0 truncate text-sm">{node.title}</span>
      </div>
      {expanded ? (
        <div className="pl-6">
          <PickLevel
            connectionId={connectionId}
            parentId={node.id}
            ancestors={path}
            root={root}
            onToggle={onToggle}
          />
        </div>
      ) : null}
    </li>
  );
}
