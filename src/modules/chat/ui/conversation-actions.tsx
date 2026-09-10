import { Delete02Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { deleteConversation, renameConversation } from "../server/functions.ts";
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
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Input } from "~/ui/primitives/input";
import { useConfirm } from "~/ui/confirm.tsx";
import type { ReactElement, ReactNode } from "react";

export interface ActionableConversation {
  readonly id: string;
  readonly title: string | null;
}

export interface ConversationActions {
  startRename: (conversation: ActionableConversation) => void;
  confirmDelete: (conversation: ActionableConversation) => Promise<void>;
  /** Mount once per surface — the shared rename dialog. */
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
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      // Only the surface that is actually showing the deleted chat navigates
      // away; on /chats there is no conversationId param at all.
      if (activeId === conversationId) await navigate({ to: "/" });
    },
    onError: () => toast.error("Could not delete the chat."),
  });

  const renameMutation = useMutation({
    mutationFn: (input: { conversationId: string; title: string }) =>
      renameConversation({ data: input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      setRenaming(null);
    },
    onError: () => toast.error("Could not rename the chat."),
  });

  const title = renaming?.title.trim() ?? "";

  return {
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

/** The Rename / Delete entries; each surface supplies its own menu trigger. */
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
