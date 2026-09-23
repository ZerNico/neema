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
import type { KnowledgeDocument } from "~/modules/knowledge/schema.ts";
import { useConfirm } from "~/ui/confirm.tsx";
import { useDetailPanel } from "~/ui/detail-panel.tsx";
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
import { FieldError } from "~/ui/primitives/field";
import { Spinner } from "~/ui/primitives/spinner";
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";
import { cn } from "~/ui/utils";
import { findIntegration } from "../catalog.ts";
import { knowledgeSourcesQuery, myIntegrationsQuery } from "../client/queries.ts";
import type { BrowseNode, KnowledgeSourceView, SourceRoot, SourceRule } from "../schema.ts";
import {
  browseIntegration,
  removeKnowledgeSource,
  saveKnowledgeSource,
  syncKnowledgeSource,
} from "../server/functions.ts";
import { IntegrationLogo, integrationName } from "./integration-logo.tsx";
import { openSyncedPages } from "./synced-pages-panel.tsx";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** What the picker works on: a new source for an integration, or an existing one. */
export type SourceTarget = { integrationId: string; sourceId?: string };

/** Connected integrations this person can sync a collection from. */
export function useSyncableIntegrations() {
  const mine = useQuery(myIntegrationsQuery);
  return (mine.data ?? []).filter(
    (integration) =>
      integration.available &&
      integration.connection?.status === "active" &&
      findIntegration(integration.id)?.knowledgeSource,
  );
}

const pages = (count: number) => `${count} ${count === 1 ? "page" : "pages"}`;

const selectionSummary = (root: SourceRoot) => {
  const includes = root.rules.filter((rule) => rule.mode === "include").length;
  const excludes = root.rules.filter((rule) => rule.mode === "exclude").length;
  if (root.mode === "all") return excludes ? `Everything except ${pages(excludes)}` : "Everything";
  return `${pages(includes)} picked${excludes ? `, ${excludes} left out` : ""}`;
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
    <Section title="Synced from">
      <ListCard>
        {list.map((source) => (
          <SourceRow
            key={source.id}
            source={source}
            documents={documents.filter((document) => document.source?.sourceId === source.id)}
            onEdit={() => onEdit({ integrationId: source.integrationId, sourceId: source.id })}
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
  const name = integrationName(source.integrationId);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["knowledge"] });
  const sync = useMutation({
    mutationFn: () => syncKnowledgeSource({ data: { sourceId: source.id } }),
    onSuccess: refresh,
    onError: (error) => toastError("Could not start the sync.", error),
  });
  const remove = useMutation({
    mutationFn: () => removeKnowledgeSource({ data: { sourceId: source.id } }),
    onSuccess: refresh,
    onError: (error) => toastError("Could not remove the source.", error),
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
  const status = !source.connected
    ? source.canEdit
      ? `Paused: ${name} isn’t connected. Pages already synced stay searchable.`
      : `Paused: the owner’s ${name} connection is off. Pages already synced stay searchable.`
    : (source.lastError ??
      [
        selectionSummary(source.root),
        preparing ? `${preparing} preparing` : null,
        failed ? `${failed} couldn’t be prepared` : null,
        source.stats?.elsewhere
          ? `${pages(source.stats.elsewhere)} already synced by another source`
          : null,
        source.stats?.tooLarge ? `${source.stats.tooLarge} too large` : null,
        source.stats?.overLimit ? `${source.stats.overLimit} over the collection limit` : null,
        source.lastSyncedAt
          ? `synced ${dateFormat.format(new Date(source.lastSyncedAt))}`
          : "not synced yet",
      ]
        .filter(Boolean)
        .join(" · "));

  return (
    <ListRow className="flex-wrap">
      <IntegrationLogo integrationId={source.integrationId} variant="tile" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 text-sm font-medium">
          <span className="min-w-0 truncate">{source.root.title}</span>
          {source.status === "syncing" ? <Badge variant="secondary">Syncing</Badge> : null}
          {source.status === "error" || !source.connected ? (
            <Badge variant="destructive">Needs attention</Badge>
          ) : null}
        </span>
        <span className="text-muted-foreground text-xs">{status}</span>
      </div>
      {documents.length ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => openSyncedPages(panel, source.collectionId, source.id, source.root.title)}
        >
          {pages(documents.length)}
        </Button>
      ) : null}
      {source.canEdit ? (
        <>
          {source.connected ? (
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Edit what is synced from ${source.root.title}`}
                onClick={onEdit}
              >
                <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
              </Button>
              <PendingButton
                size="icon-sm"
                variant="ghost"
                aria-label={`Sync ${source.root.title} now`}
                pending={sync.isPending}
                disabled={source.status === "syncing"}
                onClick={() => sync.mutate()}
              >
                <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
              </PendingButton>
            </>
          ) : (
            // Syncing resumes by itself once the owner connects again.
            <Button size="sm" variant="outline" render={<Link to="/settings/integrations" />}>
              Reconnect {name}
            </Button>
          )}
          <PendingButton
            size="icon-sm"
            variant="ghost"
            aria-label={`Stop syncing ${source.root.title}`}
            pending={remove.isPending}
            onClick={async () => {
              if (
                await confirm({
                  title: `Stop syncing “${source.root.title}”?`,
                  description: `Every page it brought in from ${name} is removed from this collection. Chats that cited them will show those sources as unavailable.`,
                  confirmLabel: "Stop syncing",
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
  if (sources.isPending) return null;
  const existing = target.sourceId
    ? sources.data?.find((source) => source.id === target.sourceId)
    : undefined;
  return (
    <SourcePicker
      collectionId={collectionId}
      integrationId={target.integrationId}
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
  sourceId,
  initial,
  open,
  onOpenChange,
}: {
  collectionId: string;
  integrationId: string;
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
  const name = integrationName(integrationId);
  const save = useMutation({
    mutationFn: (chosen: DraftRoot) =>
      saveKnowledgeSource({
        data: {
          collectionId,
          integrationId,
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
    onError: () => setError("Could not save the selection."),
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
          <DialogTitle>{step === "where" || !root ? `Sync from ${name}` : root.title}</DialogTitle>
          <DialogDescription>
            {step === "where"
              ? "Choose a collection or a page. You can add more sources to this collection later."
              : "New pages arrive and deleted ones leave by themselves."}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[28rem] min-w-0 overflow-y-auto rounded-2xl border p-2">
          {step === "where" || !root ? (
            <ChooseLevel
              integrationId={integrationId}
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
                aria-label={`What to sync from ${root.title}`}
              >
                <ToggleGroupItem value="all">Everything</ToggleGroupItem>
                <ToggleGroupItem value="selected">Only what I pick</ToggleGroupItem>
              </ToggleGroup>
              <p className="text-muted-foreground text-xs">
                {root.mode === "all"
                  ? "Uncheck pages to leave them and everything under them out."
                  : "Check pages to sync them and everything under them."}
              </p>
              {root.hasChildren ? (
                <PickLevel
                  integrationId={integrationId}
                  parentId={root.nodeId}
                  ancestors={[]}
                  root={root}
                  onToggle={togglePage}
                />
              ) : (
                <p className="text-muted-foreground text-sm">
                  Nothing is under this page yet, so only the page itself is synced.
                </p>
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
              Change source
            </Button>
          ) : null}
          <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
            Cancel
          </DialogClose>
          {step === "where" ? (
            <Button disabled={!root} onClick={() => setStep("what")}>
              Next
            </Button>
          ) : (
            <PendingButton
              pending={save.isPending}
              disabled={!root}
              onClick={() => root && save.mutate(root)}
            >
              {sourceId ? "Save and sync" : "Start syncing"}
            </PendingButton>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Loads one level of the service's tree; shared by both steps. */
function useBrowseLevel(integrationId: string, parentId: string | null) {
  return useQuery({
    queryKey: ["integration-browse", integrationId, parentId],
    queryFn: () =>
      browseIntegration({ data: { integrationId, ...(parentId ? { parentId } : {}) } }),
    staleTime: 60_000,
  });
}

function LevelState({ level }: { level: ReturnType<typeof useBrowseLevel> }) {
  if (level.isPending)
    return (
      <div className="text-muted-foreground flex items-center gap-2 p-2 text-sm">
        <Spinner /> Loading…
      </div>
    );
  if (!level.data?.ok)
    return (
      <p className="text-destructive p-2 text-sm">
        {level.data?.ok === false ? level.data.error : "Could not load this level."}
      </p>
    );
  return <p className="text-muted-foreground p-2 text-sm">Nothing here.</p>;
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
      aria-label={expanded ? `Collapse ${node.title}` : `Expand ${node.title}`}
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
  integrationId,
  parentId,
  chosen,
  onChoose,
}: {
  integrationId: string;
  parentId: string | null;
  chosen: string | null;
  onChoose: (node: BrowseNode) => void;
}) {
  const level = useBrowseLevel(integrationId, parentId);
  if (!level.data?.ok || level.data.nodes.length === 0) return <LevelState level={level} />;
  return (
    <ul className="flex flex-col" role="radiogroup" aria-label="Where to sync from">
      {level.data.nodes.map((node) => (
        <ChooseRow
          key={node.id}
          integrationId={integrationId}
          node={node}
          chosen={chosen}
          onChoose={onChoose}
        />
      ))}
    </ul>
  );
}

function ChooseRow({
  integrationId,
  node,
  chosen,
  onChoose,
}: {
  integrationId: string;
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
            integrationId={integrationId}
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
  integrationId,
  parentId,
  ancestors,
  root,
  onToggle,
}: {
  integrationId: string;
  parentId: string;
  ancestors: ReadonlyArray<string>;
  root: DraftRoot;
  onToggle: (node: BrowseNode, ancestors: ReadonlyArray<string>) => void;
}) {
  const level = useBrowseLevel(integrationId, parentId);
  if (!level.data?.ok || level.data.nodes.length === 0) return <LevelState level={level} />;
  return (
    <ul className="flex flex-col">
      {level.data.nodes.map((node) => (
        <PickRow
          key={node.id}
          integrationId={integrationId}
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
  integrationId,
  node,
  ancestors,
  root,
  onToggle,
}: {
  integrationId: string;
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
            integrationId={integrationId}
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
