import { m } from "~/paraglide/messages.js";
import { matchesWords } from "~/modules/search/match.ts";
import { AnimatePresence } from "motion/react";
import { CollapseItem } from "~/ui/motion.tsx";
import {
  Book02Icon,
  Calendar03Icon,
  Cancel01Icon,
  Folder01Icon,
  FolderLibraryIcon,
  Robot01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { agentsQuery } from "~/modules/agents/client/queries.ts";
import type { AgentSummary } from "~/modules/agents/schema.ts";
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
import { agentIcon } from "./agent-icons.ts";
import { collectionStatus } from "./collection-status.ts";

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
  /** The person's own collections; the agent's come with it and are never listed here. */
  collectionIds: ReadonlyArray<string>;
}

export interface ComposerContext {
  selection: ContextSelection;
  /** Not offered for picking: the agent already brings them. */
  agentCollectionIds: ReadonlySet<string>;
  maxCollections: number;
  agentLocked: boolean;
  onAgentChange: (agentId: string | null) => void;
  onCollectionsChange: (collectionIds: ReadonlyArray<string>) => void;
}

export const MAX_SELECTED_COLLECTIONS = KNOWLEDGE_LIMITS.maxCollectionsPerSelection;

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
          {m.chat_context_agent()}
          {selection.agent ? (
            <span className="text-muted-foreground ml-auto truncate pl-2 text-xs">
              {selection.agent.name ?? m.chat_context_unavailable()}
            </span>
          ) : null}
        </DropdownMenuItem>
      )}
      {knowledgeEnabled ? (
        <DropdownMenuItem disabled={disabled} onClick={() => onPick("collections")}>
          <HugeiconsIcon icon={FolderLibraryIcon} strokeWidth={2} />
          {m.chat_context_knowledge()}
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
  /** The side the menu opened on, so the pointer need not cross the page. */
  side: "top" | "bottom";
}

/** Searchable agent popup for a chat that has not started yet. */
export function AgentPicker({
  selection,
  onAgentChange,
  open,
  onOpenChange,
  anchor,
  side,
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
      <ComboboxContent side={side} anchor={anchor} className="w-72 min-w-72">
        <ComboboxInput
          placeholder={m.chat_context_search_agents()}
          showTrigger={false}
          aria-label={m.chat_context_agent()}
        />
        <ComboboxEmpty>
          {agents.isPending
            ? m.chat_context_loading_agents()
            : agents.isError
              ? m.chat_context_agents_failed()
              : items.length === 0
                ? m.chat_context_no_agents()
                : m.chat_context_no_agents_match()}
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

const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * Multi-select popup for this message's collections. Ticks are a draft until
 * Add commits them; Escape or clicking away discards. The agent's own are not
 * offered: they come with the agent.
 */
export function CollectionPicker({
  selection,
  agentCollectionIds,
  maxCollections,
  onCollectionsChange,
  open,
  onOpenChange,
  anchor,
  side,
}: PickerPopupProps &
  Pick<
    ComposerContext,
    "selection" | "agentCollectionIds" | "maxCollections" | "onCollectionsChange"
  >) {
  const collections = useQuery(knowledgeCollectionsQuery);
  const items = (collections.data ?? []).filter(
    (collection) => !agentCollectionIds.has(collection.id),
  );
  const [draft, setDraft] = useState<ReadonlyArray<string> | null>(null);
  const draftIds = draft ?? selection.collectionIds;
  const selected = items.filter((collection) => draftIds.includes(collection.id));
  const full = draftIds.length >= maxCollections;
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
      onValueChange={(next: CollectionSummary[]) =>
        setDraft(next.map((collection) => collection.id))
      }
      itemToStringLabel={(collection: CollectionSummary) => collection.name}
      isItemEqualToValue={(a: CollectionSummary, b: CollectionSummary) => a.id === b.id}
      filter={(collection: CollectionSummary, query: string) =>
        matchesWords(`${collection.name} ${collection.description}`, query)
      }
      autoHighlight
    >
      <ComboboxContent side={side} anchor={anchor} className="w-72 min-w-72">
        <ComboboxInput
          placeholder={m.chat_context_search_collections()}
          showTrigger={false}
          aria-label={m.chat_context_knowledge()}
        />
        <ComboboxEmpty>
          {collections.isPending
            ? m.chat_context_loading_collections()
            : collections.isError
              ? m.chat_context_collections_failed()
              : items.length === 0
                ? m.chat_context_no_collections()
                : m.chat_context_no_collections_match()}
        </ComboboxEmpty>
        <ComboboxList>
          {(collection: CollectionSummary) => (
            <ComboboxItem
              key={collection.id}
              value={collection}
              disabled={!draftIds.includes(collection.id) && full}
            >
              <span className="min-w-0 flex-1 truncate">{collection.name}</span>
              <span className="text-muted-foreground truncate text-xs font-normal">
                {collectionStatus(collection)}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
        <div className="border-border flex items-center gap-2 border-t px-3 py-2">
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
            {full
              ? maxCollections < MAX_SELECTED_COLLECTIONS
                ? m.chat_context_limit_beside_agent({ max: maxCollections })
                : m.chat_context_limit_per_message({ max: MAX_SELECTED_COLLECTIONS })
              : draftIds.length > 0
                ? m.chat_context_selected({ count: draftIds.length })
                : ""}
          </span>
          <Button
            size="sm"
            disabled={draft === null || sameIds(draft, selection.collectionIds)}
            onClick={() => {
              if (draft) onCollectionsChange(draft);
              close();
            }}
          >
            {m.chat_context_add()}
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
  readonly kind: "agent" | "collection" | "folder" | "schedule" | "skill";
  readonly id: string | null;
  /** Null when the id no longer resolves to something the viewer may read. */
  readonly name: string | null;
  readonly icon?: string | undefined;
  readonly note?: string | undefined;
}

/**
 * The agent chosen for a new chat, beside the file chips. It stands for
 * everything it brings, so its collections and skills get no chips of their
 * own. An associated agent (an existing conversation) is not a chip: the
 * composer's agent bar names it, and nothing here can remove it.
 */
export function AgentChip({
  agent,
  agentLocked,
  onAgentChange,
  disabled,
}: {
  agent: ContextSelection["agent"];
  agentLocked: boolean;
  onAgentChange: (agentId: string | null) => void;
  disabled: boolean;
}) {
  const agents = useQuery({ ...agentsQuery, enabled: !agentLocked });
  const listed = agent?.id
    ? agents.data?.find((candidate) => candidate.id === agent.id)
    : undefined;
  const name = agent?.name ?? listed?.name ?? null;
  return (
    <AnimatePresence initial={false}>
      {agent && !agentLocked ? (
        <CollapseItem key={`agent:${agent.id ?? "deleted"}`}>
          <ContextChip
            item={{
              kind: "agent",
              id: agent.id,
              name:
                name === null && !agents.isSuccess
                  ? agents.isError
                    ? m.chat_context_selection_failed()
                    : m.chat_context_loading()
                  : name,
              icon: listed?.icon ?? "robot",
              note: agent.id === null ? m.chat_context_deleted_agent() : m.chat_context_agent(),
            }}
            onRemove={disabled ? undefined : () => onAgentChange(null)}
          />
        </CollapseItem>
      ) : null}
    </AnimatePresence>
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
      ? m.chat_context_agent_unavailable()
      : item.kind === "skill"
        ? m.chat_context_skill_unavailable()
        : item.kind === "schedule"
          ? m.chat_context_schedule_unavailable()
          : m.chat_context_collection_unavailable());
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
                  : item.kind === "folder"
                    ? Folder01Icon
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
          {unavailable ? m.chat_context_no_longer_available() : item.note}
        </span>
      </span>
      {onRemove ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={m.chat_context_remove({ name: label })}
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
        note: reference.kind === "agent" ? m.chat_context_agent() : m.chat_context_schedule(),
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
            ? m.chat_context_collection_failed()
            : m.chat_context_loading(),
        note: m.chat_context_collection(),
      }}
    />
  );
}
