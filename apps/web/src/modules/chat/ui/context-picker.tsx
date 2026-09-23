import {
  Book02Icon,
  BriefcaseIcon,
  Calendar03Icon,
  Cancel01Icon,
  ChartIcon,
  FolderLibraryIcon,
  PenTool03Icon,
  Robot01Icon,
  Search01Icon,
  SourceCodeIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { agentsQuery } from "~/modules/agents/client/queries.ts";
import type { AgentIcon, AgentSummary } from "~/modules/agents/schema.ts";
import { knowledgeCollectionsQuery } from "~/modules/knowledge/client/queries.ts";
import { schedulesQuery } from "~/modules/schedules/client/queries.ts";
import type { MessageReference } from "../references.ts";
import { KNOWLEDGE_LIMITS, type CollectionSummary } from "~/modules/knowledge/schema.ts";
import { Button } from "~/ui/primitives/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "~/ui/primitives/combobox";
import { DropdownMenuItem, DropdownMenuSeparator } from "~/ui/primitives/dropdown-menu";
import { cn } from "~/ui/utils";

/** Icon identifiers are an app-side set; never a URL. */
export const AGENT_ICONS: Record<AgentIcon, IconSvgElement> = {
  robot: Robot01Icon,
  sparkles: SparklesIcon,
  code: SourceCodeIcon,
  book: Book02Icon,
  search: Search01Icon,
  pen: PenTool03Icon,
  chart: ChartIcon,
  briefcase: BriefcaseIcon,
};
export const agentIcon = (icon: string): IconSvgElement =>
  AGENT_ICONS[icon as AgentIcon] ?? Robot01Icon;

/**
 * What the composer knows about its agent and collections. Ids come from the
 * conversation; names resolve against the permission-aware lists, so a
 * selection the user can no longer read shows as unavailable rather than
 * silently disappearing, since the server refuses the turn either way.
 */
export interface ContextSelection {
  /**
   * Fixed association. A null `id` is a deletion tombstone; a null `name`
   * is an unavailable agent. Both block new attempts, never historical reading.
   */
  agent: { id: string | null; name: string | null; icon?: string } | null;
  /** Agent-attached collections (fixed by the agent) then standalone ones. */
  collectionIds: ReadonlyArray<string>;
}

export interface ComposerContext {
  selection: ContextSelection;
  agentCollectionIds: ReadonlySet<string>;
  agentSkillIds?: ReadonlySet<string>;
  agentLocked: boolean;
  onAgentChange: (agentId: string | null) => void;
  onCollectionsChange: (
    collectionIds: ReadonlyArray<string>,
    additions?: ReadonlyArray<string>,
  ) => void;
}

export const MAX_SELECTED_COLLECTIONS = KNOWLEDGE_LIMITS.maxCollectionsPerSelection;

const words = (query: string) => query.trim().toLowerCase().split(/\s+/).filter(Boolean);
const matchesWords = (haystack: string, query: string) => {
  const lower = haystack.toLowerCase();
  return words(query).every((word) => lower.includes(word));
};

export type ContextPickerKind = "agent" | "collections";

/**
 * Rows for the composer's "+" menu. Each opens the matching searchable popup
 * after the menu has closed, so the list scales past a submenu's height and
 * the two overlays never fight over focus. An associated agent has no row.
 */
export function ContextMenuItems({
  selection,
  agentLocked,
  knowledgeEnabled = true,
  onPick,
  disabled,
}: {
  selection: ContextSelection;
  agentLocked: boolean;
  knowledgeEnabled?: boolean;
  onPick: (kind: ContextPickerKind) => void;
  disabled: boolean;
}) {
  const count = selection.collectionIds.length;
  return (
    <>
      <DropdownMenuSeparator />
      {agentLocked ? null : (
        <DropdownMenuItem disabled={disabled} onClick={() => onPick("agent")}>
          <HugeiconsIcon icon={Robot01Icon} strokeWidth={2} />
          Agent
          {selection.agent ? (
            <span className="text-muted-foreground ml-auto truncate pl-2 text-xs">
              {selection.agent.name ?? "Unavailable"}
            </span>
          ) : null}
        </DropdownMenuItem>
      )}
      {knowledgeEnabled ? (
        <DropdownMenuItem disabled={disabled} onClick={() => onPick("collections")}>
          <HugeiconsIcon icon={FolderLibraryIcon} strokeWidth={2} />
          Knowledge
          {count > 0 ? (
            <span className="text-muted-foreground ml-auto pl-2 text-xs tabular-nums">{count}</span>
          ) : null}
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

/** The popup opened by a menu row: anchored to the "+" button, never to a trigger of its own. */
interface PickerPopupProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: HTMLElement | null;
}

/** Searchable agent popup for a chat that has not started yet. */
export function AgentPicker({
  selection,
  onAgentChange,
  open,
  onOpenChange,
  anchor,
}: PickerPopupProps & {
  selection: ContextSelection;
  onAgentChange: (agentId: string | null) => void;
}) {
  const agents = useQuery(agentsQuery);
  const items = agents.data ?? [];
  const selected = items.find((agent) => agent.id === selection.agent?.id) ?? null;
  return (
    <Combobox
      open={open}
      onOpenChange={onOpenChange}
      items={items}
      value={selected}
      onValueChange={(agent: AgentSummary | null) => {
        if (agent) onAgentChange(agent.id);
      }}
      itemToStringLabel={(agent: AgentSummary) => agent.name}
      isItemEqualToValue={(a: AgentSummary, b: AgentSummary) => a.id === b.id}
      filter={(agent: AgentSummary, query: string) =>
        matchesWords(`${agent.name} ${agent.description} ${agent.ownerName ?? ""}`, query)
      }
      autoHighlight
    >
      <ComboboxContent side="top" anchor={anchor} className="w-72 min-w-72">
        <ComboboxInput placeholder="Search agents…" showTrigger={false} aria-label="Agent" />
        <ComboboxEmpty>
          {agents.isPending
            ? "Loading agents…"
            : agents.isError
              ? "Could not load agents."
              : items.length === 0
                ? "No agents yet"
                : "No agents match"}
        </ComboboxEmpty>
        <ComboboxList>
          {(agent: AgentSummary) => (
            <ComboboxItem key={agent.id} value={agent}>
              <HugeiconsIcon icon={agentIcon(agent.icon)} strokeWidth={2} />
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              {agent.ownerName ? (
                <span className="text-muted-foreground truncate text-xs font-normal">
                  {agent.ownerName}
                </span>
              ) : null}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

export const collectionStatus = (collection: CollectionSummary) =>
  collection.pendingCount > 0
    ? `${collection.pendingCount} preparing`
    : collection.failedCount > 0
      ? `${collection.failedCount} failed`
      : `${collection.documentCount} docs`;

const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * Multi-select popup for this message's collections. Ticks are a draft until
 * Add commits them; Escape or clicking away discards. The agent's own
 * collections show as selected but cannot be toggled: they leave with the
 * agent, never one by one.
 */
export function CollectionPicker({
  selection,
  agentCollectionIds,
  onCollectionsChange,
  open,
  onOpenChange,
  anchor,
}: PickerPopupProps & {
  selection: ContextSelection;
  agentCollectionIds: ReadonlySet<string>;
  agentSkillIds?: ReadonlySet<string>;
  onCollectionsChange: (
    collectionIds: ReadonlyArray<string>,
    additions?: ReadonlyArray<string>,
  ) => void;
}) {
  const collections = useQuery(knowledgeCollectionsQuery);
  const items = collections.data ?? [];
  // Keep user edits as deltas, not a copied effective union: a live agent
  // refresh must not turn a removed dependency into a standalone selection.
  const [draft, setDraft] = useState<{ added: string[]; removed: string[] } | null>(null);
  const draftIds = [...new Set([...selection.collectionIds, ...(draft?.added ?? [])])].filter(
    (id) => agentCollectionIds.has(id) || !draft?.removed.includes(id),
  );
  const draftSet = new Set(draftIds);
  const selected = items.filter((collection) => draftSet.has(collection.id));
  const full = draftSet.size >= MAX_SELECTED_COLLECTIONS;
  const changed = (draft?.added.length ?? 0) > 0 || !sameIds(draftIds, selection.collectionIds);
  const close = () => {
    setDraft(null);
    onOpenChange(false);
  };
  return (
    <Combobox
      multiple
      open={open}
      onOpenChange={(next) => {
        if (!next) setDraft(null);
        onOpenChange(next);
      }}
      items={items}
      value={selected}
      onValueChange={(next: CollectionSummary[]) => {
        const ids = next.map((collection) => collection.id);
        setDraft({
          added: ids.filter(
            (id) => !selection.collectionIds.includes(id) || draft?.added.includes(id),
          ),
          removed: selection.collectionIds.filter(
            (id) => !ids.includes(id) && !agentCollectionIds.has(id),
          ),
        });
      }}
      itemToStringLabel={(collection: CollectionSummary) => collection.name}
      isItemEqualToValue={(a: CollectionSummary, b: CollectionSummary) => a.id === b.id}
      filter={(collection: CollectionSummary, query: string) =>
        matchesWords(`${collection.name} ${collection.description}`, query)
      }
      autoHighlight
    >
      <ComboboxContent side="top" anchor={anchor} className="w-72 min-w-72">
        <ComboboxInput
          placeholder="Search collections…"
          showTrigger={false}
          aria-label="Knowledge"
        />
        <ComboboxEmpty>
          {collections.isPending
            ? "Loading collections…"
            : collections.isError
              ? "Could not load collections."
              : items.length === 0
                ? "No collections yet"
                : "No collections match"}
        </ComboboxEmpty>
        <ComboboxList>
          {(collection: CollectionSummary) => {
            const fromAgent = agentCollectionIds.has(collection.id);
            return (
              <ComboboxItem
                key={collection.id}
                value={collection}
                disabled={fromAgent || (!draftSet.has(collection.id) && full)}
              >
                <span className="min-w-0 flex-1 truncate">{collection.name}</span>
                <span className="text-muted-foreground truncate text-xs font-normal">
                  {fromAgent ? "From agent" : collectionStatus(collection)}
                </span>
              </ComboboxItem>
            );
          }}
        </ComboboxList>
        <div className="border-border flex items-center gap-2 border-t px-3 py-2">
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
            {full
              ? `Up to ${MAX_SELECTED_COLLECTIONS} per message`
              : draftSet.size > 0
                ? `${draftSet.size} selected`
                : ""}
          </span>
          <Button
            size="sm"
            disabled={!changed}
            onClick={() => {
              onCollectionsChange(draftIds, draft?.added);
              close();
            }}
          >
            Add
          </Button>
        </div>
      </ComboboxContent>
    </Combobox>
  );
}

/**
 * The chips a user message and the composer show for their agent and
 * collections. They share the attachment chip's shell so context and files
 * read as one row: an icon tile, a name, and a one-line note underneath.
 */
export interface ContextChipItem {
  readonly kind: "agent" | "collection" | "schedule" | "skill";
  readonly id: string | null;
  /** Null when the id no longer resolves to something the viewer may read. */
  readonly name: string | null;
  readonly icon?: string | undefined;
  readonly note?: string | undefined;
}

export function contextChipItems(
  selection: ContextSelection,
  options: {
    agentCollectionIds: ReadonlySet<string>;
    agentSkillIds?: ReadonlySet<string>;
    collections: ReadonlyArray<{ id: string; name: string }> | undefined;
    agents: ReadonlyArray<{ id: string; name: string; icon: string }> | undefined;
  },
): ContextChipItem[] {
  const items: ContextChipItem[] = [];
  if (selection.agent) {
    const agent = selection.agent.id
      ? options.agents?.find((candidate) => candidate.id === selection.agent!.id)
      : undefined;
    items.push({
      kind: "agent",
      id: selection.agent.id,
      name: selection.agent.name ?? agent?.name ?? null,
      icon: agent?.icon ?? "robot",
      note: selection.agent.id === null ? "Deleted agent" : "Agent",
    });
  }
  for (const id of selection.collectionIds) {
    const name = options.collections?.find((candidate) => candidate.id === id)?.name ?? null;
    items.push({
      kind: "collection",
      id,
      name,
      note: options.agentCollectionIds.has(id) ? "From agent" : "Collection",
    });
  }
  return items;
}

/**
 * Chips beside the file chips. Agent-attached collections leave with the
 * agent. An associated agent (an existing conversation) is not a chip: the
 * composer's agent bar names it, and nothing here can remove it.
 */
export function ContextChips({
  selection,
  agentCollectionIds,
  agentLocked,
  onAgentChange,
  onCollectionsChange,
  disabled,
}: {
  selection: ContextSelection;
  agentCollectionIds: ReadonlySet<string>;
  agentSkillIds?: ReadonlySet<string>;
  agentLocked: boolean;
  onAgentChange: (agentId: string | null) => void;
  onCollectionsChange: (
    collectionIds: ReadonlyArray<string>,
    additions?: ReadonlyArray<string>,
  ) => void;
  disabled: boolean;
}) {
  const collections = useQuery(knowledgeCollectionsQuery);
  const agents = useQuery({ ...agentsQuery, enabled: !agentLocked });
  const items = contextChipItems(selection, {
    agentCollectionIds,
    collections: collections.data,
    agents: agents.data,
  }).filter((item) => !(agentLocked && item.kind === "agent"));
  return (
    <>
      {items.map((item) => (
        <ContextChip
          key={`${item.kind}:${item.id ?? "deleted"}`}
          item={
            item.name === null &&
            (item.kind === "collection" ? !collections.isSuccess : !agents.isSuccess)
              ? {
                  ...item,
                  name: (item.kind === "collection" ? collections.isError : agents.isError)
                    ? "Could not load selection"
                    : "Loading…",
                }
              : item
          }
          onRemove={
            disabled || (item.kind === "collection" && agentCollectionIds.has(item.id!))
              ? undefined
              : item.kind === "agent"
                ? () => onAgentChange(null)
                : () => onCollectionsChange(selection.collectionIds.filter((c) => c !== item.id))
          }
        />
      ))}
    </>
  );
}

export function ContextChip({
  item,
  onRemove,
  className,
}: {
  item: ContextChipItem;
  onRemove?: (() => void) | undefined;
  className?: string;
}) {
  const unavailable = item.name === null && item.id !== null;
  const label =
    item.name ??
    (item.kind === "agent"
      ? "Agent unavailable"
      : item.kind === "skill"
        ? "Skill unavailable"
        : item.kind === "schedule"
          ? "Schedule unavailable"
          : "Collection unavailable");
  return (
    <span
      title={label}
      className={cn(
        "border-border bg-background flex max-w-56 items-center gap-2 rounded-2xl border p-1.5 pr-2 shadow-sm",
        unavailable && "border-destructive/50",
        className,
      )}
    >
      <span className="bg-muted text-muted-foreground grid size-9 shrink-0 place-items-center rounded-xl">
        <HugeiconsIcon
          icon={
            item.kind === "agent"
              ? agentIcon(item.icon ?? "robot")
              : item.kind === "skill"
                ? Book02Icon
                : item.kind === "schedule"
                  ? Calendar03Icon
                  : FolderLibraryIcon
          }
          strokeWidth={2}
          className="size-4"
        />
      </span>
      <span className="flex min-w-0 flex-col text-left">
        <span className="truncate text-xs font-medium">{label}</span>
        <span
          className={cn(
            "text-2xs truncate",
            unavailable ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {unavailable ? "No longer available to you" : item.note}
        </span>
      </span>
      {onRemove ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
          className="-mr-1 size-6 shrink-0"
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3" />
        </Button>
      ) : null}
    </span>
  );
}

/**
 * The agent or schedule a message is about, by its current name. Until the
 * list arrives the link's own words stand in; a reference that no longer
 * resolves says so, the way an unavailable collection does.
 */
export function ReferenceChip({
  reference,
  onRemove,
}: {
  reference: MessageReference;
  onRemove?: (() => void) | undefined;
}) {
  const agents = useQuery({ ...agentsQuery, enabled: reference.kind === "agent" });
  const schedules = useQuery({ ...schedulesQuery, enabled: reference.kind === "schedule" });
  const agent = agents.data?.find((candidate) => candidate.id === reference.id);
  const schedule = schedules.data?.find((candidate) => candidate.id === reference.id);
  const loaded =
    reference.kind === "agent" ? agents.data !== undefined : schedules.data !== undefined;
  const name = agent?.name ?? schedule?.name ?? (loaded ? null : reference.label);
  return (
    <ContextChip
      item={{
        kind: reference.kind,
        id: reference.id,
        name,
        icon: agent?.icon,
        note: reference.kind === "agent" ? "Agent" : "Schedule",
      }}
      onRemove={onRemove}
    />
  );
}

/** A sent message's collection, by name. Read-only: the turn already happened. */
export function CollectionChip({ collectionId }: { collectionId: string }) {
  const collections = useQuery(knowledgeCollectionsQuery);
  const name = collections.data?.find((c) => c.id === collectionId)?.name ?? null;
  return (
    <ContextChip
      item={{
        kind: "collection",
        id: collectionId,
        name: collections.isSuccess
          ? name
          : collections.isError
            ? "Could not load collection"
            : "Loading…",
        note: "Collection",
      }}
    />
  );
}
