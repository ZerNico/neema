import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { toast } from "sonner";
import { useDesktop } from "~/modules/desktop/client/bridge.ts";
import {
  dispatchQueuedMessage,
  queueMessage,
  removeQueuedMessage,
  replaceQueuedMessage,
  sendQueuedNow,
  steerQueuedMessage,
} from "../server/functions.ts";
import type { ConversationMode } from "../schema.ts";
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

/** This app's desktop fields, which give a Work entry its machine. */
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
/** A start the page refused after saying why itself, so it needs no second toast. */
export class StartBlocked extends Error {}

const failed = (fallback: string) => (error: unknown) => {
  if (error instanceof StartBlocked) return;
  toast.error(error instanceof Error && error.message ? error.message : fallback);
};

/**
 * Everything the chat view does with its queue: queueing, editing, steering,
 * sending now, and saying why it waits. The view passes in what only it owns:
 * what a send carries right now, and the composer settings an edit borrows.
 */
export function useConversationQueue(input: {
  conversationId: string;
  mode: ConversationMode;
  rows: ReadonlyArray<QueueRow>;
  state: QueueState;
  /** The answer running now, which Steer aims at. */
  running: { messageId: string; generationId: string } | null;
  /** Steers the live stream says the running answer has taken in. */
  arrived: ReadonlyArray<AssistantSteer>;
  /** What a send would carry now besides the draft; queueing freezes it. */
  submission: () => Promise<Submission>;
  /** This app's desktop fields; a Work entry needs them to start. */
  attemptFields: () => Promise<AttemptFields>;
  /** Throws, having said why, when Work cannot act yet. */
  checkWork: () => void;
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
  const desktop = useDesktop();
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
    onMutate: () => input.checkWork(),
    mutationFn: async (draft: Draft) => queueMessage({ data: await fields(draft) }),
    onSuccess: () => {
      settings.resetSearchEnabled();
      settings.settleCollections();
      refresh();
    },
    onError: failed("Could not queue your message."),
  });
  const replace = useMutation({
    onMutate: () => input.checkWork(),
    mutationFn: async (draft: Draft & { entryId: string }) =>
      replaceQueuedMessage({ data: { ...(await fields(draft)), entryId: draft.entryId } }),
    onSuccess: refresh,
    onError: failed("Could not save the queued message."),
  });
  const remove = useMutation({
    mutationFn: (entryId: string) => removeQueuedMessage({ data: { conversationId, entryId } }),
    onSuccess: refresh,
    onError: failed("Could not remove the queued message."),
  });
  const steer = useMutation({
    mutationFn: (target: { entryId: string; messageId: string; generationId: string }) =>
      steerQueuedMessage({ data: { conversationId, ...target } }),
    onSuccess: refresh,
    onError: failed("Could not send that into the response."),
  });
  const sendNow = useMutation({
    onMutate: () => input.prepare(),
    // One request stops a running answer, waits for it to settle and starts
    // this entry, so nothing here has to sequence a stop and a send.
    mutationFn: async (entryId: string) =>
      sendQueuedNow({ data: { conversationId, entryId, ...(await input.attemptFields()) } }),
    onSuccess: refresh,
    onError: failed("Could not send the queued message."),
  });
  const dispatch = useMutation({
    onMutate: () => input.prepare(),
    // A person asking may start after a stop. A Work chat's entry takes this
    // app's executor and folders as they are now, never the queued ones.
    mutationFn: async () =>
      dispatchQueuedMessage({
        data: { conversationId, force: true, ...(await input.attemptFields()) },
      }),
    onSuccess: refresh,
    onError: failed("Could not start the queued message."),
  });

  // The one reason only this page knows: whether it is the desktop app a Work
  // entry needs to start at all. Everything else comes from the server's gate.
  const needsDesktop = input.mode === "work" && !desktop;
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
      paused: pausedReason(input.state, needsDesktop),
      // Send now stops the answer first; where nothing could start afterwards
      // it must not stop anything, so it is refused before the click.
      sendNowBlocked: needsDesktop
        ? "Open Chat Desktop to send queued work"
        : input.state === "question"
          ? "Answer the questions above first"
          : null,
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
const pausedReason = (state: QueueState, needsDesktop: boolean): ComposerQueue["paused"] => {
  switch (state) {
    case null:
    case "running":
      return null;
    case "question":
      return { reason: "Answer the questions above to continue", canDispatch: false };
    case "ready":
      return needsDesktop
        ? { reason: "Open Chat Desktop to continue this work", canDispatch: false }
        : { reason: "Starting the next message…", canDispatch: false };
    case "stopped":
    case "failed":
      return needsDesktop
        ? { reason: "Open Chat Desktop to continue this work", canDispatch: false }
        : { reason: "Queue paused", canDispatch: true };
  }
};
