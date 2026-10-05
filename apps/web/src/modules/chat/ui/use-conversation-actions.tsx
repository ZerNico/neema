import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { discardWorkspace } from "~/modules/desktop/client/bridge.ts";
import { useConfirm } from "~/ui/confirm-context.ts";
import { toastError } from "~/ui/error-toast.ts";
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
import { Input } from "~/ui/primitives/input";
import {
  deleteConversation,
  renameConversation,
  setConversationArchived,
} from "../server/functions.ts";
import type { ConversationActions } from "./conversation-actions.tsx";

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
