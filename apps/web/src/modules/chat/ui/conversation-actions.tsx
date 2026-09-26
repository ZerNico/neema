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
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import {
  deleteConversation,
  renameConversation,
  setConversationArchived,
} from "../server/functions.ts";
import { discardWorkspace } from "~/modules/desktop/client/bridge.ts";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
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
import { Input } from "~/ui/primitives/input";
import { useConfirm } from "~/ui/confirm.tsx";
import type { ReactElement, ReactNode } from "react";
import { toastError } from "~/ui/error-toast.ts";
import { toast } from "sonner";

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
  confirmDelete: (conversation: ActionableConversation) => Promise<void>;
  /** Mount once per surface: the shared rename dialog. */
  renameDialog: ReactNode;
}

/**
 * Rename and delete for a conversation row, shared by the sidebar and the
 * chats page so both behave identically. Invalidation is by the
 * `["conversations"]` prefix, which covers every page and search variant on
 * both surfaces.
 */
export function useConversationActions(): ConversationActions {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const params = useParams({ strict: false });
  const activeId = "conversationId" in params ? params.conversationId : undefined;
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);

  const removeMutation = useMutation({
    mutationFn: (conversationId: string) => deleteConversation({ data: { conversationId } }),
    onSuccess: async (_, conversationId) => {
      // Best-effort: a work chat's local workspace dies with it. A failure
      // leaves a stray directory, nothing the server waits for; a no-op in a
      // browser.
      discardWorkspace(conversationId);
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      // Only the surface that is actually showing the deleted chat navigates
      // away; on /chats there is no conversationId param at all.
      if (activeId === conversationId) await navigate({ to: "/" });
    },
    onError: (error) => toastError("Could not delete the chat.", error),
  });

  const archiveMutation = useMutation({
    mutationFn: (input: { conversationId: string; archived: boolean }) =>
      setConversationArchived({ data: input }),
    onSuccess: async (_, input) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
        queryClient.invalidateQueries({ queryKey: ["conversation", input.conversationId] }),
      ]);
      // The chat leaves every list at once, so offer the way straight back.
      if (input.archived)
        toast("Chat archived", {
          action: {
            label: "Undo",
            onClick: () =>
              archiveMutation.mutate({ conversationId: input.conversationId, archived: false }),
          },
        });
    },
    onError: (error, input) =>
      toastError(
        input.archived ? "Could not archive the chat." : "Could not unarchive the chat.",
        error,
      ),
  });

  const renameMutation = useMutation({
    mutationFn: (input: { conversationId: string; title: string }) =>
      renameConversation({ data: input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      setRenaming(null);
    },
    onError: (error) => toastError("Could not rename the chat.", error),
  });

  const title = renaming?.title.trim() ?? "";

  return {
    setArchived: (conversation, archived) =>
      archiveMutation.mutate({ conversationId: conversation.id, archived }),
    startRename: (conversation) =>
      setRenaming({ id: conversation.id, title: conversation.title ?? "" }),
    confirmDelete: async (conversation) => {
      if (
        await confirm({
          title: `Delete “${conversation.title ?? "New chat"}”?`,
          description: "The chat and all its messages are removed permanently.",
          confirmLabel: "Delete chat",
        })
      ) {
        removeMutation.mutate(conversation.id);
      }
    },
    renameDialog: (
      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => !open && !renameMutation.isPending && setRenaming(null)}
      >
        <DialogContent>
          {/* A form so Enter in the field saves, like any rename prompt. */}
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (renaming && title) {
                renameMutation.mutate({ conversationId: renaming.id, title });
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename chat</DialogTitle>
            </DialogHeader>
            <Input
              value={renaming?.title ?? ""}
              onChange={(e) => setRenaming((r) => (r ? { ...r, title: e.target.value } : r))}
              aria-label="Chat title"
              disabled={renameMutation.isPending}
              autoFocus
            />
            <DialogFooter>
              <DialogClose
                render={<Button variant="outline" disabled={renameMutation.isPending} />}
              >
                Cancel
              </DialogClose>
              <PendingButton type="submit" pending={renameMutation.isPending} disabled={!title}>
                Save
              </PendingButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    ),
  };
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
      <DropdownMenuItem variant="destructive" onClick={() => actions.confirmDelete(conversation)}>
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
