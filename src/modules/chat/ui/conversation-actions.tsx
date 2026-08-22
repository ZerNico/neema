import { Delete02Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { deleteConversation, renameConversation } from "../server/functions.ts";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { DropdownMenuItem } from "~/ui/primitives/dropdown-menu";
import { Input } from "~/ui/primitives/input";
import { useConfirm } from "~/ui/confirm.tsx";
import type { ReactNode } from "react";

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
  });

  const renameMutation = useMutation({
    mutationFn: (input: { conversationId: string; title: string }) =>
      renameConversation({ data: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["conversations"] }),
  });

  return {
    startRename: (conversation) =>
      setRenaming({ id: conversation.id, title: conversation.title ?? "" }),
    confirmDelete: async (conversation) => {
      if (
        await confirm({
          title: `Delete "${conversation.title ?? "New chat"}"?`,
          description: "The chat and all its messages are removed permanently.",
          confirmLabel: "Delete chat",
        })
      ) {
        removeMutation.mutate(conversation.id);
      }
    },
    renameDialog: (
      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
          </DialogHeader>
          <Input
            value={renaming?.title ?? ""}
            onChange={(e) => setRenaming((r) => (r ? { ...r, title: e.target.value } : r))}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (renaming && renaming.title.trim()) {
                  renameMutation.mutate({
                    conversationId: renaming.id,
                    title: renaming.title.trim(),
                  });
                  setRenaming(null);
                }
              }}
            >
              Save
            </Button>
          </DialogFooter>
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
        <HugeiconsIcon icon={PencilEdit02Icon} className="size-4" />
        Rename
      </DropdownMenuItem>
      <DropdownMenuItem variant="destructive" onClick={() => actions.confirmDelete(conversation)}>
        <HugeiconsIcon icon={Delete02Icon} className="size-4" />
        Delete
      </DropdownMenuItem>
    </>
  );
}
