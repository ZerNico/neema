import type { UiImages } from "../../assistant-output.ts";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import { IMAGE_TOOL, ImageToolActivity } from "~/modules/images/tool-schema.ts";
import { composeFileReferenceAliases } from "../../file-reference-aliases.ts";
import { projectResearchProgress } from "../../research-schema.ts";
import { researchRuns, researchTasks } from "~/db/schema/research.ts";
import { uuidv7 } from "uuidv7";
import {
  conversationAgents,
  conversationCompactionCheckpoints,
  conversations,
  messageCompactionEvents,
  messageGenerationConfig,
  messageSkills,
  messageKnowledgeVersions,
  messages,
  messageToolCalls,
  messageUiStates,
  conversationIntegrations,
} from "~/db/schema/index.ts";
import { ownedConversationById } from "../owned-conversation.ts";
import { projectRole } from "~/modules/projects/server/access.ts";
import type { JsonValue } from "~/db/schema/providers.ts";
import { CustomToolActivity } from "~/modules/custom-tools/tool-schema.ts";
import { isCustomToolName } from "~/modules/custom-tools/schema.ts";
import { ToolFileActivity } from "../../tool-file-schema.ts";
import { BranchNotAllowed, ConversationNotFound, MessageNotFound } from "../../errors.ts";
import { rejectReservedWorkTurn } from "./work-turns.ts";
import type { RepoContext } from "./context.ts";
import type { ChatRepo } from "../repo.ts";

/**
 * A branch's tool rows name its own copies of the files they delivered, so a
 * file card still groups under the call that produced it there.
 */
const withClonedFileIds = (
  toolName: string,
  result: JsonValue | null,
  cloned: ReadonlyMap<string, string>,
): JsonValue | null => {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const copy = (id: string) => {
    const cloneId = cloned.get(id);
    return cloneId ? [cloneId] : [];
  };
  // Both deliver a file under the same activity shape; a copy points at the branch's own.
  if (toolName === "publish_file" || toolName === "create_file") {
    const stored = Option.getOrUndefined(Schema.decodeUnknownOption(ToolFileActivity)(result));
    if (stored?.attachmentId) {
      const next = { ...result };
      delete next.attachmentId;
      const [id] = copy(stored.attachmentId);
      return id ? { ...next, attachmentId: id } : next;
    }
  }
  if (isCustomToolName(toolName)) {
    const stored = Option.getOrUndefined(Schema.decodeUnknownOption(CustomToolActivity)(result));
    if (stored?.fileIds) return { ...result, fileIds: stored.fileIds.flatMap(copy) };
  }
  if (toolName === IMAGE_TOOL) {
    const stored = Option.getOrUndefined(Schema.decodeUnknownOption(ImageToolActivity)(result));
    if (stored) return { ...result, attachmentIds: stored.attachmentIds.flatMap(copy) };
  }
  return result;
};

/** A branch's copy of an answer's image results, pointing at the cloned attachments. */
const remapUiImages = (images: UiImages, attachmentIds: ReadonlyMap<string, string>): UiImages =>
  Object.fromEntries(
    Object.entries(images).map(([query, result]) => [
      query,
      {
        ...result,
        items: result.items.flatMap((item) => {
          const id = attachmentIds.get(item.attachmentId);
          return id ? [{ ...item, attachmentId: id }] : [];
        }),
      },
    ]),
  );

export const branchMethods = ({ db, attachments }: RepoContext) =>
  ({
    cloneConversationPrefix: Effect.fn("ChatRepo.cloneConversationPrefix")(function* (input) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* rejectReservedWorkTurn(tx, input.sourceConversationId);
            // Locks both sides of what is being copied: the conversation
            // row against a concurrent rename/title/delete, the messages
            // against a retry or edit rewinding history mid-copy.
            const sourceRows = yield* tx
              .select()
              .from(conversations)
              .where(ownedConversationById(input.sourceConversationId, input.userId))
              .for("update")
              .pipe(Effect.orDie);
            const source = sourceRows[0];
            if (!source) {
              return yield* new ConversationNotFound({
                conversationId: input.sourceConversationId,
              });
            }

            const all = yield* tx
              .select()
              .from(messages)
              .where(eq(messages.conversationId, source.id))
              .orderBy(asc(messages.createdAt), asc(messages.id))
              .for("update")
              .pipe(Effect.orDie);

            // Position in the list, never the timestamp: two messages of
            // the same turn can share a clock tick.
            const index = all.findIndex((m) => m.id === input.throughMessageId);
            if (index === -1) {
              return yield* new MessageNotFound({ messageId: input.throughMessageId });
            }
            const target = all[index]!;
            if (target.role !== "assistant") {
              return yield* new BranchNotAllowed({
                messageId: input.throughMessageId,
                reason: "only assistant messages can be branched from",
              });
            }
            // A steer sorts just after the answer it went into, so the
            // target's own steers follow it; they belong to that answer.
            let end = index + 1;
            while (all[end]?.steeredIntoMessageId === target.id) end += 1;
            const prefix = all.slice(0, end);
            // A cloned streaming row would have no fiber to finish it.
            if (prefix.some((m) => m.status === "streaming")) {
              return yield* new BranchNotAllowed({
                messageId: input.throughMessageId,
                reason: "message is still generating",
              });
            }

            // A branch stays in the project only while its owner may still use it.
            const branchProjectId =
              source.projectId && (yield* projectRole(tx, source.userId, source.projectId))
                ? source.projectId
                : null;
            const branchRows = yield* tx
              .insert(conversations)
              .values({
                id: uuidv7(),
                userId: source.userId,
                projectId: branchProjectId,
                // Whatever the locked row says is used: a title that resolved
                // between the service's read and this lock counts.
                title: source.title,
                modelId: source.modelId,
                imageModelId: source.imageModelId,
                // A branch of a work chat is still work: its history is
                // full of folder activity the continuation has to match.
                // The approval level is a fact about the chat too.
                mode: source.mode,
                permissionLevel: source.permissionLevel,
                // A copy of a temporary chat must not outlive it in the
                // sidebar; it gets its own day from now.
                temporary: source.temporary,
                branchedFrom: source.id,
                // Left null so the branch sorts by its own createdAt (now)
                // and lands at the top of the list, like a new chat.
                lastMessageAt: null,
              })
              .returning()
              .pipe(Effect.orDie);
            const branch = branchRows[0]!;
            // A chat's account choices go with it, like its approval
            // level. Answers already given to waiting calls do not.
            const integrationChoices = yield* tx
              .select()
              .from(conversationIntegrations)
              .where(eq(conversationIntegrations.conversationId, source.id))
              .pipe(Effect.orDie);
            if (integrationChoices.length)
              yield* tx
                .insert(conversationIntegrations)
                .values(
                  integrationChoices.map((choice) => ({
                    ...choice,
                    conversationId: branch.id,
                  })),
                )
                .pipe(Effect.orDie);

            const clonedIds = new Map(prefix.map((m) => [m.id, uuidv7()] as const));
            yield* tx
              .insert(messages)
              .values(
                prefix.map((m) => ({
                  ...m,
                  id: clonedIds.get(m.id)!,
                  conversationId: branch.id,
                  generationId: null,
                  generationLeaseUntil: null,
                  // A steer sorts just before its answer, so the answer is
                  // always in the same prefix; point at the copy.
                  steeredIntoMessageId: m.steeredIntoMessageId
                    ? (clonedIds.get(m.steeredIntoMessageId) ?? null)
                    : null,
                  // createdAt/completedAt/editedAt stay as they were: the
                  // branch shows the same history, day dividers included.
                })),
              )
              .pipe(Effect.orDie);

            const toolCalls = yield* tx
              .select()
              .from(messageToolCalls)
              .where(inArray(messageToolCalls.messageId, [...clonedIds.keys()]))
              .pipe(Effect.orDie);
            const toolIds = new Map(toolCalls.map((call) => [call.id, uuidv7()] as const));
            const runs = yield* tx
              .select()
              .from(researchRuns)
              .where(
                and(
                  inArray(researchRuns.messageId, [...clonedIds.keys()]),
                  eq(researchRuns.status, "terminal"),
                ),
              )
              .orderBy(asc(researchRuns.createdAt))
              .pipe(Effect.orDie);
            const runIds = new Map(runs.map((run) => [run.id, uuidv7()] as const));
            const tasks = runs.length
              ? yield* tx
                  .select()
                  .from(researchTasks)
                  .where(inArray(researchTasks.runId, [...runIds.keys()]))
                  .pipe(Effect.orDie)
              : [];
            const taskIds = new Map(tasks.map((task) => [task.id, uuidv7()] as const));
            // Older progress may have a display task with no retained task row.
            for (const run of runs)
              for (const task of run.progress.tasks)
                if (!taskIds.has(task.id)) taskIds.set(task.id, uuidv7());
            const clonedProgress = new Map(
              runs.map(
                (run) =>
                  [
                    run.id,
                    projectResearchProgress({
                      ...run.progress,
                      runId: runIds.get(run.id)!,
                      tasks: run.progress.tasks.map((task) => ({
                        ...task,
                        id: taskIds.get(task.id)!,
                      })),
                    }),
                  ] as const,
              ),
            );
            const rootRuns = new Map(
              runs.flatMap((run) => (run.toolCallId ? [[run.toolCallId, run.id] as const] : [])),
            );
            const unlinkedRuns = new Set(
              runs.filter((run) => !run.toolCallId).map((run) => run.id),
            );
            for (const call of toolCalls) {
              if (
                rootRuns.has(call.id) ||
                call.toolName !== "deep_research" ||
                !call.result ||
                typeof call.result !== "object" ||
                Array.isArray(call.result)
              )
                continue;
              const progress = call.result.progress;
              if (
                progress &&
                typeof progress === "object" &&
                !Array.isArray(progress) &&
                typeof progress.runId === "string" &&
                unlinkedRuns.delete(progress.runId)
              )
                rootRuns.set(call.id, progress.runId);
            }
            if (runs.length)
              yield* tx
                .insert(researchRuns)
                .values(
                  runs.map((run) => ({
                    ...run,
                    id: runIds.get(run.id)!,
                    conversationId: branch.id,
                    messageId: clonedIds.get(run.messageId)!,
                    // Roots are inserted below; this FK must not name the source.
                    toolCallId: null,
                    owner: null,
                    cancelRequested: false,
                    snapshot: true,
                    progress: clonedProgress.get(run.id)!,
                  })),
                )
                .pipe(Effect.orDie);
            if (tasks.length)
              yield* tx
                .insert(researchTasks)
                .values(
                  tasks.map((task) => ({
                    ...task,
                    id: taskIds.get(task.id)!,
                    runId: runIds.get(task.runId)!,
                  })),
                )
                .pipe(Effect.orDie);

            const attachmentIds = yield* attachments.cloneForMessages(tx, {
              userId: input.userId,
              messages: [...clonedIds].map(([sourceMessageId, targetMessageId]) => ({
                sourceMessageId,
                targetMessageId,
              })),
            });

            // Tool calls are part of the answer, not of its generation:
            // the sources panel and the citation numbering both read them.
            if (toolCalls.length > 0) {
              yield* tx
                .insert(messageToolCalls)
                .values(
                  toolCalls.map((call) => ({
                    ...call,
                    id: toolIds.get(call.id)!,
                    researchRunId: call.researchRunId
                      ? (runIds.get(call.researchRunId) ?? null)
                      : null,
                    researchTaskId: call.researchTaskId
                      ? (taskIds.get(call.researchTaskId) ?? null)
                      : null,
                    result: rootRuns.has(call.id)
                      ? (JSON.parse(
                          JSON.stringify({
                            ...(call.result as object),
                            progress: clonedProgress.get(rootRuns.get(call.id)!),
                          }),
                        ) as JsonValue)
                      : withClonedFileIds(call.toolName, call.result, attachmentIds),
                    messageId: clonedIds.get(call.messageId)!,
                  })),
                )
                .pipe(Effect.orDie);
            }

            for (const [toolCallId, runId] of rootRuns)
              if (toolIds.has(toolCallId))
                yield* tx
                  .update(researchRuns)
                  .set({ toolCallId: toolIds.get(toolCallId)! })
                  .where(eq(researchRuns.id, runIds.get(runId)!))
                  .pipe(Effect.orDie);

            // A branch shows the same answers as the reader left them.
            const uiStates = yield* tx
              .select()
              .from(messageUiStates)
              .where(inArray(messageUiStates.messageId, [...clonedIds.keys()]))
              .pipe(Effect.orDie);
            if (uiStates.length > 0) {
              yield* tx
                .insert(messageUiStates)
                .values(
                  uiStates.map((row) => ({ ...row, messageId: clonedIds.get(row.messageId)! })),
                )
                .pipe(Effect.orDie);
            }

            // Agent/knowledge configuration is copied verbatim, never
            // re-resolved: the branch shows the same answers the same way,
            // and its next turn resolves the associated agent live.
            const [installedAgent] = yield* tx
              .select()
              .from(conversationAgents)
              .where(eq(conversationAgents.conversationId, source.id))
              .pipe(Effect.orDie);
            if (installedAgent)
              yield* tx
                .insert(conversationAgents)
                .values({ ...installedAgent, conversationId: branch.id })
                .pipe(Effect.orDie);
            const configs = yield* tx
              .select()
              .from(messageGenerationConfig)
              .where(inArray(messageGenerationConfig.messageId, [...clonedIds.keys()]))
              .pipe(Effect.orDie);
            if (configs.length > 0)
              yield* tx
                .insert(messageGenerationConfig)
                .values(
                  configs.map((row) => ({ ...row, messageId: clonedIds.get(row.messageId)! })),
                )
                .pipe(Effect.orDie);
            const skillRefs = yield* tx
              .select()
              .from(messageSkills)
              .where(inArray(messageSkills.messageId, [...clonedIds.keys()]))
              .pipe(Effect.orDie);
            if (skillRefs.length)
              yield* tx
                .insert(messageSkills)
                .values(
                  skillRefs.map((row) => ({
                    ...row,
                    messageId: clonedIds.get(row.messageId)!,
                  })),
                )
                .pipe(Effect.orDie);
            const manifests = yield* tx
              .select()
              .from(messageKnowledgeVersions)
              .where(inArray(messageKnowledgeVersions.messageId, [...clonedIds.keys()]))
              .pipe(Effect.orDie);
            if (manifests.length > 0)
              yield* tx
                .insert(messageKnowledgeVersions)
                .values(
                  manifests.map((row) => ({
                    ...row,
                    messageId: clonedIds.get(row.messageId)!,
                  })),
                )
                .pipe(Effect.orDie);

            const fileReferenceAliases = composeFileReferenceAliases({
              sourceConversationId: source.id,
              inherited: source.fileReferenceAliases,
              attachmentIds,
            });
            yield* tx
              .update(conversations)
              .set({ fileReferenceAliases })
              .where(eq(conversations.id, branch.id))
              .pipe(Effect.orDie);
            for (const message of prefix) {
              if (!message.assistantOutput) continue;
              yield* tx
                .update(messages)
                .set({
                  assistantOutput: {
                    ...message.assistantOutput,
                    files: message.assistantOutput.files.map((file) => {
                      const id = attachmentIds.get(file.attachment.id);
                      if (!id) throw new Error("Missing cloned assistant file");
                      const toolCallId = file.origin && toolIds.get(file.origin.toolCallId);
                      return {
                        ...file,
                        attachment: { ...file.attachment, id },
                        ...(file.origin
                          ? { origin: { toolCallId: toolCallId ?? file.origin.toolCallId } }
                          : {}),
                      };
                    }),
                    ...(message.assistantOutput.images
                      ? { images: remapUiImages(message.assistantOutput.images, attachmentIds) }
                      : {}),
                  },
                })
                .where(eq(messages.id, clonedIds.get(message.id)!))
                .pipe(Effect.orDie);
            }

            // Compaction checkpoints follow the prefix they describe. Only
            // those whose boundary is inside the copied range are eligible,
            // since a summary ending past the branch point covers messages
            // this conversation does not have. createdAt is preserved so
            // the clones keep their relative age.
            const checkpoints = yield* tx
              .select()
              .from(conversationCompactionCheckpoints)
              .where(eq(conversationCompactionCheckpoints.conversationId, source.id))
              .pipe(Effect.orDie);
            const inherited = checkpoints.filter((checkpoint) =>
              clonedIds.has(checkpoint.throughMessageId),
            );
            const checkpointIds = new Map(
              inherited.map((checkpoint) => [checkpoint.id, uuidv7()] as const),
            );
            if (inherited.length > 0) {
              yield* tx
                .insert(conversationCompactionCheckpoints)
                .values(
                  inherited.map((checkpoint) => ({
                    ...checkpoint,
                    id: checkpointIds.get(checkpoint.id)!,
                    conversationId: branch.id,
                    throughMessageId: clonedIds.get(checkpoint.throughMessageId)!,
                  })),
                )
                .pipe(Effect.orDie);
            }

            // Compaction activity belongs to the assistant row that
            // performed it. Clone every visible event in the copied prefix;
            // checkpoint linkage survives only when that semantic
            // checkpoint was itself valid for (and cloned into) the branch.
            const compactionEvents = (yield* tx
              .select()
              .from(messageCompactionEvents)
              .where(inArray(messageCompactionEvents.messageId, [...clonedIds.keys()]))
              .pipe(Effect.orDie)).filter(
              (event) => !event.researchRunId || runIds.has(event.researchRunId),
            );
            // An orphan research event has no cloned scope. Omit it, never turn its private body into a chat summary.
            if (compactionEvents.length > 0) {
              yield* tx
                .insert(messageCompactionEvents)
                .values(
                  compactionEvents.map((event) => ({
                    ...event,
                    id: uuidv7(),
                    messageId: clonedIds.get(event.messageId)!,
                    researchRunId: event.researchRunId ? runIds.get(event.researchRunId)! : null,
                    researchTaskId: event.researchTaskId
                      ? (taskIds.get(event.researchTaskId) ?? null)
                      : null,
                    checkpointId: event.checkpointId
                      ? (checkpointIds.get(event.checkpointId) ?? null)
                      : null,
                  })),
                )
                .pipe(Effect.orDie);
            }

            // message_chunks are deliberately not copied. They exist so a
            // reconnecting client can replay a live stream, and nothing in
            // the branch is live.
            return { ...branch, fileReferenceAliases };
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die));
    }),
  }) satisfies Partial<ChatRepo["Service"]>;
