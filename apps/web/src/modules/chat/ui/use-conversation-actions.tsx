import { m } from "~/paraglide/messages.js";
import { MAX_SEARCH_LENGTH } from "~/modules/search/text.ts";
import { NameDialog } from "~/ui/name-dialog.tsx";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { toastError } from "~/ui/error-toast.ts";
import {
  deleteConversation,
  renameConversation,
  restoreConversation,
  setConversationArchived,
} from "../server/functions.ts";
import { holdRow, inLane } from "../client/held-rows.ts";
import { undoToast } from "~/ui/undo-toast.ts";
import type { ConversationActions } from "./conversation-actions.tsx";

/**
 * Rename, archive and delete for a conversation row, shared by the sidebar,
 * the chats page and the archived list so all behave identically. Archive and
 * delete act at once and offer Undo; see docs/internals/deleted-chats.md.
 * Invalidation is by the `["conversations"]` prefix, which covers every page
 * and search variant.
 */
export function useConversationActions(): ConversationActions {
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false });
  const activeId = "conversationId" in params ? params.conversationId : undefined;
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);

  const refresh = (conversationId: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["conversations"] }),
      queryClient.invalidateQueries({ queryKey: ["projects", "chats"] }),
      queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] }),
    ]);

  /**
   * Holds the chat out of every list, runs `act`, and offers to run `revert`
   * with what `act` returned once it has landed; `act` returning null means
   * there was nothing to reverse. Undo shows the chat again at once. A chat
   * that `leaves` is closed if open, and reopened only after the server
   * agrees it exists again, and only if the reader is still where the close
   * left them.
   */
  const reversibly = async <T,>(input: {
    conversationId: string;
    leaves: boolean;
    done: string;
    failed: string;
    act: () => Promise<T | null>;
    revert: (acted: T) => Promise<boolean>;
  }) => {
    const { conversationId } = input;
    const closed = input.leaves && activeId === conversationId;
    const hold = await holdRow(queryClient, conversationId);
    if (closed) void navigate({ to: "/" });
    const acted = inLane(conversationId, input.act);
    let undone = false;
    const undo = async () => {
      undone = true;
      hold.show();
      const result = await acted.catch(() => null);
      // A failed or empty act is handled below, which already said so.
      if (result === null) return;
      const reverted = await inLane(conversationId, () => input.revert(result)).catch(
        (error: unknown) => {
          toastError(m.chat_actions_undo_failed(), error);
          return null;
        },
      );
      hold.release();
      await refresh(conversationId);
      if (reverted === false) toast(m.chat_actions_already_gone());
      else if (reverted && closed && router.state.location.pathname === "/")
        await navigate({ to: "/chat/$conversationId", params: { conversationId } });
    };
    const dismiss = undoToast(input.done, () => void undo());
    acted.then(
      (result) => {
        if (result === null) dismiss();
        // An Undo under way releases once its own revert has landed.
        else if (undone) return;
        hold.release();
        return refresh(conversationId);
      },
      (error: unknown) => {
        dismiss();
        hold.show();
        hold.release();
        void refresh(conversationId);
        toastError(input.failed, error);
      },
    );
  };

  const unarchiveMutation = useMutation({
    mutationFn: (conversationId: string) =>
      inLane(conversationId, () =>
        setConversationArchived({ data: { conversationId, archived: false } }),
      ),
    onMutate: (conversationId) => holdRow(queryClient, conversationId),
    onSuccess: (_, conversationId, hold) => {
      hold.release();
      return refresh(conversationId);
    },
    onError: (error, conversationId, hold) => {
      hold?.show();
      hold?.release();
      void refresh(conversationId);
      toastError(m.chat_actions_unarchive_failed(), error);
    },
  });

  return {
    setArchived: (conversation, archived) => {
      if (!archived) return unarchiveMutation.mutate(conversation.id);
      const conversationId = conversation.id;
      void reversibly({
        conversationId,
        // An archived chat still opens; only the lists let it go.
        leaves: false,
        done: m.chat_actions_archived(),
        failed: m.chat_actions_archive_failed(),
        act: () =>
          setConversationArchived({ data: { conversationId, archived: true } }).then(() => true),
        revert: () =>
          setConversationArchived({ data: { conversationId, archived: false } }).then(() => true),
      });
    },
    startRename: (conversation) =>
      setRenaming({ id: conversation.id, title: conversation.title ?? "" }),
    remove: (conversation) => {
      const conversationId = conversation.id;
      void reversibly({
        conversationId,
        leaves: true,
        done: m.chat_actions_deleted(),
        failed: m.chat_actions_delete_failed(),
        act: () => deleteConversation({ data: { conversationId } }),
        revert: (mark) => restoreConversation({ data: { conversationId, mark } }),
      });
    },
    renameDialog: (
      // Keyed by the chat, so one rename's typing never shows in the next.
      <NameDialog
        key={renaming?.id}
        open={renaming !== null}
        onOpenChange={(open) => !open && setRenaming(null)}
        title={m.chat_rename_title()}
        label={m.chat_rename_label()}
        initial={renaming?.title ?? ""}
        maxLength={MAX_SEARCH_LENGTH}
        submitLabel={m.chat_rename_submit()}
        failure={m.chat_rename_failed()}
        onSubmit={async (title) => {
          if (!renaming) return;
          await renameConversation({ data: { conversationId: renaming.id, title } });
          await queryClient.invalidateQueries({ queryKey: ["conversations"] });
        }}
      />
    ),
  };
}
