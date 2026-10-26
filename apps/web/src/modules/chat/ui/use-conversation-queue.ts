import { m } from "~/paraglide/messages.js";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { toast } from "sonner";
import { AlreadyTold } from "~/ui/error-toast.ts";
import {
  dispatchQueuedMessage,
  queueMessage,
  removeQueuedMessage,
  replaceQueuedMessage,
  sendQueuedNow,
  steerQueuedMessage,
} from "../server/functions.ts";
import type { ReasoningEffort } from "~/modules/providers/model-config.ts";
import type { AssistantSteer } from "./assistant-body.ts";
import type { ComposerQueue, EditableQueuedMessage } from "./composer.tsx";

/** A queue row as the conversation loader ships it; only what the queue reads. */
export interface QueueRow extends EditableQueuedMessage {
  steerGenerationId: string | null;
  input: EditableQueuedMessage["input"] & {
    modelId: string;
    imageModelId?: string | null;
    searchEnabled: boolean;
    collectionIds?: ReadonlyArray<string> | undefined;
  };
}

/** What a send carries besides the draft itself; queueing freezes it. */
type Submission = Omit<
  Parameters<typeof queueMessage>[0]["data"],
  "conversationId" | "content" | "attachmentIds" | "researchEnabled" | "skillIds"
>;

/** What the desktop app adds to a start, so its browser can run the answer's browser calls. */
type AttemptFields = Omit<
  Parameters<typeof sendQueuedNow>[0]["data"],
  "conversationId" | "entryId"
>;

/** The loader's `queueState`: why the queue is or is not moving. */
export type QueueState = "running" | "question" | "ready" | "stopped" | "failed" | null;

/** A draft handed to the queue, as the composer submits it. */
type SubmitArguments = [
  content: string,
  attachmentIds: ReadonlyArray<string>,
  researchEnabled: boolean,
  skillIds?: ReadonlyArray<string>,
];

interface Draft {
  content: string;
  attachmentIds: ReadonlyArray<string>;
  researchEnabled: boolean;
  skillIds?: ReadonlyArray<string> | undefined;
}

/** Shows the server's reason for a refused queue action, or a fallback. */
const failed = (fallback: () => string) => (error: unknown) => {
  if (error instanceof AlreadyTold) return;
  toast.error(error instanceof Error && error.message ? error.message : fallback());
};

/**
 * Everything the chat view does with its queue: queueing, editing, steering,
 * sending now, and saying why it waits. The view passes in what only it owns:
 * what a send carries right now, and the composer settings an edit borrows.
 */
export function useConversationQueue(input: {
  conversationId: string;
  rows: ReadonlyArray<QueueRow>;
  state: QueueState;
  /** The answer running now, which Steer aims at. */
  running: { messageId: string; generationId: string } | null;
  /** Steers the live stream says the running answer has taken in. */
  arrived: ReadonlyArray<AssistantSteer>;
  /** What a send would carry now besides the draft; queueing freezes it. */
  submission: () => Promise<Submission>;
  /** This app's desktop fields, empty in a browser. */
  attemptFields: () => Promise<AttemptFields>;
  /** What starting an answer here runs first, like the view's own starts. */
  prepare: () => Promise<void>;
  /** The composer settings an edit of a queued message borrows and hands back. */
  settings: {
    modelId: string | null;
    setModelId: (modelId: string | null) => void;
    /** The image model picked for the next send; null leaves it to the chat's lock. */
    imageModelId: string | null;
    setImageModelId: (imageModelId: string | null) => void;
    reasoningEffort?: ReasoningEffort | null;
    setReasoningEffort?: (effort: ReasoningEffort | null, modelId?: string | null) => void;
    searchPreference: boolean | null;
    setSearchEnabled: (enabled: boolean | null) => void;
    resetSearchEnabled: () => void;
    /** The composer's own collection picks, apart from the agent's. */
    collectionIds: ReadonlyArray<string>;
    seedCollections: (ids: ReadonlyArray<string>) => void;
    settleCollections: () => void;
  };
}): { submit: (...draft: SubmitArguments) => Promise<unknown>; queue: ComposerQueue } {
  const { conversationId, settings } = input;
  const queryClient = useQueryClient();
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });

  // A queued submission freezes what a send would carry, taken now: editing
  // the composer afterwards cannot rewrite work already handed over.
  const fields = async (draft: Draft) => ({
    ...(await input.submission()),
    conversationId,
    content: draft.content,
    attachmentIds: [...draft.attachmentIds],
    researchEnabled: draft.researchEnabled,
    skillIds: [...(draft.skillIds ?? [])],
  });

  const queue = useMutation({
    mutationFn: async (draft: Draft) => queueMessage({ data: await fields(draft) }),
    onSuccess: () => {
      settings.resetSearchEnabled();
      settings.settleCollections();
      refresh();
    },
    onError: failed(m.chat_queue_add_failed),
  });
  const replace = useMutation({
    mutationFn: async (draft: Draft & { entryId: string }) =>
      replaceQueuedMessage({ data: { ...(await fields(draft)), entryId: draft.entryId } }),
    onSuccess: refresh,
    onError: failed(m.chat_queue_save_failed),
  });
  const remove = useMutation({
    mutationFn: (entryId: string) => removeQueuedMessage({ data: { conversationId, entryId } }),
    onSuccess: refresh,
    onError: failed(m.chat_queue_remove_failed),
  });
  const steer = useMutation({
    mutationFn: (target: { entryId: string; messageId: string; generationId: string }) =>
      steerQueuedMessage({ data: { conversationId, ...target } }),
    onSuccess: refresh,
    onError: failed(m.chat_queue_steer_failed),
  });
  const sendNow = useMutation({
    onMutate: () => input.prepare(),
    // One request stops a running answer, waits for it to settle and starts
    // this entry, so nothing here has to sequence a stop and a send.
    mutationFn: async (entryId: string) =>
      sendQueuedNow({ data: { conversationId, entryId, ...(await input.attemptFields()) } }),
    onSuccess: refresh,
    onError: failed(m.chat_queue_send_failed),
  });
  const dispatch = useMutation({
    onMutate: () => input.prepare(),
    // A person asking may start after a stop.
    mutationFn: async () =>
      dispatchQueuedMessage({
        data: { conversationId, force: true, ...(await input.attemptFields()) },
      }),
    onSuccess: refresh,
    onError: failed(m.chat_queue_start_failed),
  });

  // The composer settings an open edit borrowed, handed back when it ends.
  const borrowed = useRef<{
    modelId: string | null;
    imageModelId: string | null;
    reasoningEffort: ReasoningEffort | null;
    searchPreference: boolean | null;
    collectionIds: ReadonlyArray<string>;
  } | null>(null);

  return {
    submit: (content, attachmentIds, researchEnabled, skillIds) =>
      queue.mutateAsync({ content, attachmentIds, researchEnabled, skillIds }),
    queue: {
      // Hidden once the stream says the answer took it in, ahead of the
      // refetch that removes the row.
      entries: input.rows.filter(
        (row) => !input.arrived.some((arrived) => arrived.queueEntryId === row.id),
      ),
      // Aimed at the answer running now, or on its way there: the row says so
      // at once rather than looking ignored.
      steeringIds: new Set(
        input.rows
          .filter(
            (row) =>
              (!!input.running && row.steerGenerationId === input.running.generationId) ||
              (steer.isPending && steer.variables.entryId === row.id),
          )
          .map((row) => row.id),
      ),
      paused: pausedReason(input.state),
      // Send now stops the answer first; where nothing could start afterwards
      // it must not stop anything, so it is refused before the click.
      sendNowBlocked: input.state === "question" ? m.chat_queue_answer_first() : null,
      onSteer: (entryId) => {
        if (!input.running) return;
        steer.mutate({ entryId, ...input.running });
      },
      onRemove: (entryId) => remove.mutate(entryId),
      onSendNow: (entryId) => sendNow.mutate(entryId),
      onDispatch: () => dispatch.mutate(),
      onReplace: (entryId, content, attachmentIds, researchEnabled, skillIds) =>
        replace.mutateAsync({ entryId, content, attachmentIds, researchEnabled, skillIds }),
      onEditStart: (entry) => {
        borrowed.current = {
          modelId: settings.modelId,
          imageModelId: settings.imageModelId,
          reasoningEffort: settings.reasoningEffort ?? null,
          searchPreference: settings.searchPreference,
          collectionIds: settings.collectionIds,
        };
        const row = input.rows.find((item) => item.id === entry.id);
        if (!row) return;
        settings.setModelId(row.input.modelId);
        settings.setImageModelId(row.input.imageModelId ?? null);
        settings.setReasoningEffort?.(row.input.reasoningEffort ?? null, row.input.modelId);
        settings.setSearchEnabled(row.input.searchEnabled);
        settings.seedCollections(row.input.collectionIds ?? []);
      },
      onEditEnd: () => {
        if (borrowed.current) {
          settings.setModelId(borrowed.current.modelId);
          settings.setImageModelId(borrowed.current.imageModelId);
          settings.setReasoningEffort?.(borrowed.current.reasoningEffort, borrowed.current.modelId);
          settings.setSearchEnabled(borrowed.current.searchPreference);
          settings.seedCollections(borrowed.current.collectionIds);
        } else settings.settleCollections();
        borrowed.current = null;
      },
    },
  };
}

/** Why an idle queue is not moving, as the strip words it. */
const pausedReason = (state: QueueState): ComposerQueue["paused"] => {
  switch (state) {
    case null:
    case "running":
      return null;
    case "question":
      return { reason: m.chat_queue_paused_question(), canDispatch: false };
    case "ready":
      return { reason: m.chat_queue_starting(), canDispatch: false };
    case "stopped":
    case "failed":
      return { reason: m.chat_queue_paused(), canDispatch: true };
  }
};
