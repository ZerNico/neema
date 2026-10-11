import {
  ArchiveArrowDownIcon,
  ArchiveArrowUpIcon,
  Delete02Icon,
  Folder01Icon,
  FolderTransferIcon,
  PencilEdit02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { capabilitiesQuery } from "~/modules/groups/client/queries.ts";
import { projectsQuery } from "~/modules/projects/client/queries.ts";
import { moveConversationToProject } from "~/modules/projects/server/functions.ts";
import type { ReactElement, ReactNode } from "react";
import { toastError } from "~/ui/error-toast.ts";

export interface ActionableConversation {
  readonly id: string;
  readonly title: string | null;
  /** Present on list rows; a temporary chat never joins a project. */
  readonly projectId?: string | null;
  readonly temporary?: boolean;
  /** Set on the archived list; everything else a menu opens on is unarchived. */
  readonly archived?: boolean;
}

export interface ConversationActions {
  startRename: (conversation: ActionableConversation) => void;
  setArchived: (conversation: ActionableConversation, archived: boolean) => void;
  /** Deletes at once and offers Undo; no confirmation. */
  remove: (conversation: ActionableConversation) => void;
  /** Mount once per surface: the shared rename dialog. */
  renameDialog: ReactNode;
}

/** The Rename / Move / Archive / Delete entries; each surface supplies its own menu trigger. */
export function ConversationMenuItems({
  conversation,
  actions,
}: {
  conversation: ActionableConversation;
  actions: ConversationActions;
}) {
  return (
    <>
      <DropdownMenuItem onClick={() => actions.startRename(conversation)}>
        <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
        Rename
      </DropdownMenuItem>
      {conversation.temporary ? null : <MoveToProject conversation={conversation} />}
      {/* Nothing lists a temporary chat, so it has nowhere to be archived from. */}
      {conversation.temporary ? null : (
        <DropdownMenuItem onClick={() => actions.setArchived(conversation, !conversation.archived)}>
          <HugeiconsIcon
            icon={conversation.archived ? ArchiveArrowUpIcon : ArchiveArrowDownIcon}
            strokeWidth={2}
          />
          {conversation.archived ? "Unarchive" : "Archive"}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem variant="destructive" onClick={() => actions.remove(conversation)}>
        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
        Delete
      </DropdownMenuItem>
    </>
  );
}

/**
 * The per-row menu with its placement fixed here, so the sidebar and the
 * chats page open it the same way. `trigger` is the element the menu button
 * renders as (the DropdownMenuTrigger idiom); `children` is its icon.
 */
export function ConversationMenu({
  conversation,
  actions,
  trigger,
  children,
}: {
  conversation: ActionableConversation;
  actions: ConversationActions;
  trigger: ReactElement<Record<string, unknown>>;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger}>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end">
        <ConversationMenuItems conversation={conversation} actions={actions} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Moves a chat into one of the person's projects, or back out. */
function MoveToProject({ conversation }: { conversation: ActionableConversation }) {
  const queryClient = useQueryClient();
  const { data: capabilities } = useQuery(capabilitiesQuery);
  const projects = useQuery({ ...projectsQuery, enabled: !!capabilities?.projectsUse });
  const move = useMutation({
    mutationFn: (projectId: string | null) =>
      moveConversationToProject({ data: { conversationId: conversation.id, projectId } }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
        queryClient.invalidateQueries({ queryKey: ["conversation", conversation.id] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]),
    onError: (error) => toastError("Could not move the chat.", error),
  });
  if (!capabilities?.projectsUse || (!projects.data?.length && !conversation.projectId))
    return null;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={move.isPending}>
        <HugeiconsIcon icon={FolderTransferIcon} strokeWidth={2} />
        Move to project
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
        {(projects.data ?? []).map((project) => (
          <DropdownMenuItem
            key={project.id}
            disabled={project.id === conversation.projectId}
            onClick={() => move.mutate(project.id)}
          >
            <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} />
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            {project.id === conversation.projectId ? (
              <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} />
            ) : null}
          </DropdownMenuItem>
        ))}
        {conversation.projectId ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => move.mutate(null)}>
              Remove from project
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
