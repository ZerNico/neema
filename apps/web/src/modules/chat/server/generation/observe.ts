import { desktopToolTimeout, unusableDesktopResult } from "~/modules/desktop/tool-schema.ts";
import {
  ProjectFileToolName,
  projectFileFailureReason,
  projectFileResultOk,
  projectProjectFileResult,
} from "~/modules/projects/file-tool-schema.ts";
import { ResearchToolResult } from "../research/tool.ts";
import {
  DocumentToolName,
  documentFailureReason,
  projectDocumentResult,
  documentResultOk,
  isDocumentWrite,
} from "~/modules/documents/tool-schema.ts";
import {
  AgentDraftToolName,
  agentDraftFailureReason,
  projectAgentDraftResult,
  agentDraftResultOk,
} from "~/modules/agents/tool-schema.ts";
import {
  ScheduleDraftToolName,
  projectScheduleDraftResult,
  scheduleDraftFailureReason,
  scheduleDraftResultOk,
} from "~/modules/schedules/tool-schema.ts";
import { SkillToolName, projectSkillToolResult } from "~/modules/skills/tool-schema.ts";
import { officeFamilyOfEdit } from "~/modules/office/families.ts";
import { attachmentKind } from "~/modules/attachments/constants.ts";
import { acceptGeneratedFile, acceptGeneratedImage } from "../generated-files.ts";
import {
  MAP_ROUTE_TOOL,
  MapRouteResult,
  summarizeMapRoute,
} from "~/modules/genui/map-tool-schema.ts";
import { fileForModel } from "../file-for-model.ts";
import { attachmentReferenceHint } from "../../file-references.ts";
import { type GenerationIdentity } from "../generation-fence.ts";
import { appendReplay, replayUnitOf } from "../provider-replay.ts";
import { type ImageQuality, replayOf } from "@chat/model-client";
import { Deferred, Effect, Option, Schema } from "effect";
import { AskUserParams, AskUserResult } from "~/modules/tools/ask-user-schema.ts";
import { PlanToolResult } from "~/modules/tools/plan-schema.ts";
import { Prompt, type Response } from "effect/unstable/ai";
import { uuidv7 } from "uuidv7";
import { addFinishUsage, providerCostOf } from "~/modules/analytics/server/usage.ts";
import { formatFileRef, parseFileRef } from "../file-ref.ts";
import { ToolFileActivity } from "../../tool-file-schema.ts";
import { SaveMemoryResult } from "~/modules/memory/server/memory-tool.ts";
import { KnowledgeToolName, projectKnowledgeToolResult } from "~/modules/knowledge/tool-schema.ts";
import { imageCallShape } from "~/modules/images/server/image-tool.ts";
import {
  IMAGE_TOOL,
  imageActivity,
  runningImageActivity,
  type ImageToolActivity,
} from "~/modules/images/tool-schema.ts";
import { type AssistantFileSource } from "../../assistant-output.ts";
import { projectCustomToolResult } from "~/modules/custom-tools/tool-schema.ts";
import { projectIntegrationToolResult } from "~/modules/integrations/tool-schema.ts";
import { NotifyToolResult } from "~/modules/schedules/notify-schema.ts";
import { isBrowserTool, shownBrowserArgs } from "~/modules/browser/tool-schema.ts";
import { debugArguments, storedArguments } from "../stored-arguments.ts";
import { mergeSource } from "~/modules/tools/sources.ts";
import type { ToolChunkEnvelope, WebToolResult } from "~/modules/tools/schema.ts";
import {
  DesktopToolName,
  DesktopToolResult,
  forTranscript,
} from "~/modules/desktop/tool-schema.ts";
import { attachmentReadActivity } from "../attachment-reader.ts";
import { historyActivity } from "../history-tools.ts";
import { HistoryToolName } from "../../history-tool-schema.ts";
import { LoadToolsResult } from "~/modules/tools/tool-load-schema.ts";
import type { JsonValue } from "~/db/schema/providers.ts";
import { json } from "./json.ts";
import type { RoundEnv } from "./round.ts";
import type { ChatStreamPart } from "~/modules/providers/server/gateway.ts";
import type { DbTx } from "~/server/db.ts";

type ToolFamily = ToolChunkEnvelope["family"];
/**
 * What a call's row keeps of its arguments. Content in its own deletable row
 * (memory, drafts, documents) leaves nothing; tools that write content keep a
 * trimmed copy, since it lives in what they made; the rest keep what is shown.
 * Every family names one, so a new one cannot fall through to the wrong one.
 */
const STORED_ARGUMENTS = {
  memory: "none",
  "agent-draft": "none",
  "schedule-draft": "none",
  document: "none",
  skill: "trimmed",
  "project-file": "trimmed",
  "tool-file": "trimmed",
  presentation: "trimmed",
  spreadsheet: "trimmed",
  word: "trimmed",
  research: "trimmed",
  integration: "trimmed",
  image: "trimmed",
  ask: "ask",
  web: "shown",
  knowledge: "shown",
  desktop: "shown",
  plan: "shown",
  notify: "shown",
  map: "shown",
  attachment: "shown",
  history: "shown",
  "tool-load": "shown",
  custom: "shown",
} as const satisfies Record<ToolFamily, "none" | "trimmed" | "ask" | "shown">;

type StartEnvelope = Extract<ToolChunkEnvelope, { phase: "start" }>;
/** A start envelope without the fields every one of them shares. */
type StartFields = StartEnvelope extends infer E
  ? E extends unknown
    ? Omit<E, "v" | "phase" | "callId" | "turnIndex" | "callIndex" | "textOffset">
    : never
  : never;

/**
 * A family whose result is its projected activity, the handler's own reason
 * when it did not do its job, and a row marked by whether it did. One shape
 * for the row and the envelope, so the four such families settle the same way.
 */
const settledBy =
  <N extends string, A extends object>(family: {
    isName: (name: unknown) => name is N;
    project: (raw: unknown) => A;
    reason: (raw: unknown) => string | undefined;
    ok: (activity: A) => boolean;
    /** The row's error code when it did not do its job. */
    code: string;
    /** The reason for a call whose part failed: its output is the driver's, not the handler's. */
    failed: string;
    envelope: (input: {
      callId: string;
      name: N;
      activity: A;
      reason: string | undefined;
    }) => ToolChunkEnvelope;
  }) =>
  (part: { name: string; result: unknown; isFailure: boolean }, callId: string) => {
    if (!family.isName(part.name)) return null;
    const activity = family.project(part.isFailure ? null : part.result);
    const reason = part.isFailure ? family.failed : family.reason(part.result);
    return {
      result: activity,
      ok: family.ok(activity),
      error: reason ? { code: family.code, message: reason } : null,
      envelope: family.envelope({ callId, name: part.name, activity, reason }),
    };
  };

const SETTLED_FAMILIES = [
  settledBy<AgentDraftToolName, ReturnType<typeof projectAgentDraftResult>>({
    isName: Schema.is(AgentDraftToolName),
    project: projectAgentDraftResult,
    reason: agentDraftFailureReason,
    ok: agentDraftResultOk,
    code: "AgentDraftNotUpdated",
    failed: "The draft tool failed before it could respond.",
    envelope: ({ callId, name, activity, reason }) => ({
      v: 1,
      family: "agent-draft",
      phase: "result",
      callId,
      name,
      ...activity,
      ...(reason ? { reason } : {}),
    }),
  }),
  settledBy<ScheduleDraftToolName, ReturnType<typeof projectScheduleDraftResult>>({
    isName: Schema.is(ScheduleDraftToolName),
    project: projectScheduleDraftResult,
    reason: scheduleDraftFailureReason,
    ok: scheduleDraftResultOk,
    code: "ScheduleDraftNotUpdated",
    failed: "The draft tool failed before it could respond.",
    envelope: ({ callId, name, activity, reason }) => ({
      v: 1,
      family: "schedule-draft",
      phase: "result",
      callId,
      name,
      ...activity,
      ...(reason ? { reason } : {}),
    }),
  }),
  settledBy<DocumentToolName, ReturnType<typeof projectDocumentResult>>({
    isName: Schema.is(DocumentToolName),
    project: projectDocumentResult,
    reason: documentFailureReason,
    ok: documentResultOk,
    code: "DocumentNotUpdated",
    failed: "The document tool failed before it could respond.",
    envelope: ({ callId, name, activity, reason }) => ({
      v: 1,
      family: "document",
      phase: "result",
      callId,
      name,
      ...activity,
      ...(reason ? { reason } : {}),
    }),
  }),
  // File text the model read stays in this answer's rounds; the row keeps which file and version.
  settledBy<ProjectFileToolName, ReturnType<typeof projectProjectFileResult>>({
    isName: Schema.is(ProjectFileToolName),
    project: projectProjectFileResult,
    reason: projectFileFailureReason,
    ok: projectFileResultOk,
    code: "ProjectFileNotUsed",
    failed: "The project file tool failed before it could respond.",
    envelope: ({ callId, name, activity, reason }) => ({
      v: 1,
      family: "project-file",
      phase: "result",
      callId,
      name,
      ...activity,
      ...(reason ? { reason } : {}),
    }),
  }),
];

/**
 * The first line of a machine tool's result that returned a file: its
 * reference, and whether the user sees it. Only a shared screenshot or a
 * published file ever reaches them.
 */
const returnedLine = (
  name: string,
  reference: string,
  shared: { readonly attachment: unknown } | { readonly reason: string } | null,
) => {
  if (name !== "browser_snapshot")
    return `Returned file ${reference}: for other tools, or publish_file to give it to the user, who cannot see it otherwise.`;
  if (shared === null)
    return `Screenshot ${reference}: only you see it. To show the user, take it with share.`;
  return "attachment" in shared
    ? `Screenshot ${reference}: shared with the user, attached to your answer.`
    : `Screenshot ${reference}: it could not be shared (${shared.reason}); only you see it.`;
};

/** One provider call's own state: where it is in the answer and what its calls left. */
export interface TurnState {
  readonly turn: number;
  /** The next call's index within the turn. */
  callIndex: number;
  finishReason: Response.FinishReason | undefined;
  readonly turnStartOffset: number;
  /** File parts for the model, appended to the round after its results. */
  readonly turnFiles: Array<Prompt.UserMessagePartEncoded>;
  /** Provider call id to our durable row id. */
  readonly callRowIds: Map<string, string>;
  /** What an image call draws, named at its start and kept for its result. */
  readonly imageCalls: Map<string, ImageToolActivity>;
  /** Where each call was made in the answer's text, for envelopes sent after it. */
  readonly callTextOffsets: Map<string, number>;
  /** The argument summary an integration row showed at start, for its result. */
  readonly integrationSummaries: Map<string, string | null>;
  /** Snapshots asked to show their screenshot to the user, by provider call id. */
  readonly sharedSnapshots: Set<string>;
}

/**
 * Handles one part of the model's stream: text and reasoning become chunks,
 * a tool call gets its row and start marker, a result settles that row, and
 * the finish records usage and the replay unit.
 */
export const observePart = (
  env: RoundEnv,
  turnState: TurnState,
  part: ChatStreamPart,
  isPreliminary: boolean,
) =>
  Effect.gen(function* () {
    const { deps, input, ctx, sink, usage, tools, promptDeps, attemptPrompt } = env;
    const { repo, external, imageAttachments, keptFiles } = deps;
    const { fence, config, model, imageOutput } = ctx;
    const {
      documents,
      authority,
      imageResolver,
      mapResolver,
      callRowReady,
      notifyTools,
      mapRouteTools,
      workingFiles,
      toolFiles,
      officeFamilyOf,
      customTools,
      imageModel,
      imageBudget,
      imageTool,
      fileDelivery,
      publishFileTool,
      createFileTool,
      customToolNames,
      customToolOwners,
      customToolDisplayName,
      integrationTools,
      knowledgeTools,
      temporary,
      unlockTool,
    } = tools;
    const { state, sourcesByIndex } = attemptPrompt;
    const {
      turn,
      turnStartOffset,
      turnFiles,
      callRowIds,
      imageCalls,
      callTextOffsets,
      integrationSummaries,
      sharedSnapshots,
    } = turnState;
    // One fenced registration for every file an answer delivers (a
    // publish, a custom tool's output, a shared screenshot): the
    // attachment and its file chunk land together, under the fence.
    const deliverFile = (
      file: {
        name: string;
        mediaType: string;
        bytes: Uint8Array;
        fileSource?: AssistantFileSource;
        reserved?: boolean;
      },
      toolCallId: string,
      inTransaction?: (tx: DbTx, owner: GenerationIdentity) => Effect.Effect<ReadonlyArray<string>>,
    ) =>
      Effect.gen(function* () {
        if (!fence || Option.isNone(imageAttachments))
          return { reason: "File delivery is unavailable." } as const;
        yield* sink.flush;
        const accepted = yield* sink
          .fileChunk(
            (at) =>
              acceptGeneratedFile(imageAttachments.value, {
                fence,
                fileName: file.name,
                mediaType: file.mediaType,
                bytes: file.bytes,
                origin: { toolCallId },
                source: file.fileSource ?? "tool",
                ...(file.reserved ? { reserved: true } : {}),
                ...(inTransaction ? { inTransaction: (tx: DbTx) => inTransaction(tx, fence) } : {}),
                textOffset: at.textOffset,
                turnIndex: turn,
                callIndex: turnState.callIndex,
                eventIndex: at.seq,
                seq: at.seq,
              }),
            { countsAsDelivered: true },
          )
          .pipe(Effect.result);
        return accepted._tag === "Success"
          ? ({ attachment: accepted.success.attachment } as const)
          : ({ reason: accepted.failure.reason } as const);
      });
    switch (part.type) {
      case "file": {
        if (!imageOutput || !fence || Option.isNone(imageAttachments))
          return yield* Effect.die(new Error("Image output is unavailable for this call."));
        yield* sink.flush;
        const image = yield* sink.fileChunk(
          (at) =>
            acceptGeneratedImage(imageAttachments.value, {
              fence,
              mediaType: part.mediaType,
              data: part.data,
              textOffset: at.textOffset,
              turnIndex: turn,
              callIndex: turnState.callIndex,
              eventIndex: at.seq,
              seq: at.seq,
            }),
          { countsAsDelivered: false },
        );
        turnFiles.push({
          type: "text",
          text: attachmentReferenceHint(image.attachment),
        });
        // Held for good, so a later tool call does not draw what cannot be kept.
        imageBudget.reserve(1);
        sink.countDeliveredFile();
        return;
      }
      case "text-delta": {
        sink.push("text", part.delta);
        // Only a fence line can close a block.
        if (/[`~]/.test(part.delta)) {
          if (imageResolver) yield* imageResolver.observe(sink.text());
          if (mapResolver) yield* mapResolver.observe(sink.text());
        }
        if (sink.buffered() >= 16 || sink.awaitingFirstWords()) yield* sink.flush;
        return;
      }
      case "reasoning-delta": {
        // The adapter writes encrypted reasoning as the text
        // "[REDACTED]"; the encrypted part still rides the
        // replay, so the reader gets the bare thinking marker.
        sink.push("reasoning", part.delta === "[REDACTED]" ? "" : part.delta);
        if (sink.buffered() >= 16 || sink.awaitingFirstWords()) yield* sink.flush;
        return;
      }
      case "reasoning-start": {
        // Hidden-reasoning marker: an empty reasoning chunk lets
        // the UI show "Thinking…" even if no readable trace follows.
        sink.push("reasoning", "");
        return;
      }
      case "tool-call": {
        const args = part.params as Record<string, unknown>;
        unlockTool(part.name);
        if (part.name === "load_skill") {
          if (args.skillId === "builtin:agent-authoring") unlockTool("draft_agent");
          if (args.skillId === "builtin:schedule-authoring") unlockTool("draft_schedule");
        }
        const family = tools.familyOf(part.name);
        if (!family) return;
        const rowId = uuidv7();
        callRowIds.set(part.id, rowId);
        const askArgs = family === "ask" ? Schema.decodeUnknownOption(AskUserParams)(args) : null;
        const textOffset = sink.text().length;
        callTextOffsets.set(part.id, textOffset);
        const shownArgs = shownBrowserArgs(part.name, args);
        if (part.name === "browser_snapshot" && args.share === true) sharedSnapshots.add(part.id);
        yield* repo.insertToolCall({
          id: rowId,
          messageId: input.messageId,
          turnIndex: turn,
          callIndex: turnState.callIndex++,
          textOffset,
          providerCallId: part.id,
          toolName: part.name,
          // A page loading mid-draw shows the model and frame the live start names.
          ...(family === "image" && imageModel
            ? {
                result: json(runningImageActivity(imageCallShape(imageModel, args))),
              }
            : {}),
          arguments:
            STORED_ARGUMENTS[family] === "none"
              ? {}
              : STORED_ARGUMENTS[family] === "trimmed"
                ? storedArguments(args)
                : STORED_ARGUMENTS[family] === "ask"
                  ? askArgs && Option.isSome(askArgs)
                    ? json(askArgs.value)
                    : {}
                  : (shownArgs as JsonValue),
        });
        // Typed browser text may be a password; owned content has its own row.
        if (STORED_ARGUMENTS[family] !== "none")
          sink.keepDebugArguments(rowId, debugArguments(shownArgs));
        const start = (fields: StartFields) =>
          sink.pushTool({
            v: 1,
            phase: "start",
            callId: rowId,
            turnIndex: turn,
            callIndex: turnState.callIndex - 1,
            textOffset,
            ...fields,
          });
        if (family === "research") {
          // The handler cannot learn its own row id: the
          // toolkit hands it the provider's call id, and this
          // row is minted here. It waits on the same handshake
          // the desktop tools use, then describes its own run.
          yield* Deferred.succeed(callRowReady(part.id), {
            rowId,
            turnIndex: turn,
            callIndex: turnState.callIndex - 1,
            textOffset,
          });
          return;
        }
        const office = officeFamilyOf(part.name);
        if (office) {
          yield* start({ family: office.family, name: part.name });
          return;
        }
        if (family === "tool-file") {
          yield* start({
            family: "tool-file",
            name: part.name === "create_file" ? "create_file" : "publish_file",
          });
          return;
        }
        if (family === "attachment") {
          yield* start({ family, name: "read_attachment" });
          return;
        }
        if (family === "history" && Schema.is(HistoryToolName)(part.name)) {
          yield* start({ family, name: part.name });
          return;
        }
        if (family === "tool-load") {
          yield* start({ family, name: "load_tools" });
          return;
        }
        if (
          family === "memory" ||
          family === "ask" ||
          family === "plan" ||
          family === "notify" ||
          family === "map"
        ) {
          yield* start(
            family === "plan" ? { family, name: "update_plan" } : { family, name: part.name },
          );
          return;
        }
        if (family === "desktop") {
          // SDK handlers run concurrently with this observer.
          // Release them only after the owned registration exists.
          const ready = callRowReady(part.id);
          if (!input.desktopExecutorId || !input.generationId) {
            yield* Deferred.succeed(ready, undefined);
            return;
          }
          yield* external.open(rowId, {
            userId: input.userId,
            conversationId: input.conversationId,
            messageId: input.messageId,
            generationId: input.generationId,
            executorId: input.desktopExecutorId,
            deviceSessionId: input.deviceSessionId,
            name: part.name,
            args,
            // Only the browser needs to know: whether the user's own
            // text vouched for the address, and whether to keep pages.
            ...(isBrowserTool(part.name)
              ? {
                  meta: {
                    preauthorized:
                      typeof args.url === "string" && authority.resolve(args.url) !== null,
                    temporary,
                  },
                }
              : {}),
            timeoutMs: desktopToolTimeout(part.name as DesktopToolName),
          });
          yield* Deferred.succeed(ready, {
            rowId,
            turnIndex: turn,
            callIndex: turnState.callIndex - 1,
          });
          yield* start({
            family,
            name: part.name as DesktopToolName,
            args: shownArgs,
          });
          return;
        }
        if (family === "agent-draft") {
          yield* start({ family, name: part.name as AgentDraftToolName });
          return;
        }
        if (family === "schedule-draft") {
          yield* start({ family, name: part.name as ScheduleDraftToolName });
          return;
        }
        if (family === "document") {
          yield* start({ family, name: part.name as DocumentToolName });
          return;
        }
        if (family === "project-file") {
          yield* start({ family, name: part.name as ProjectFileToolName });
          return;
        }
        if (family === "integration") {
          const entry = integrationTools!.names.get(part.name)!;
          const summary = entry.tool.summarize(args)?.slice(0, 200) ?? null;
          integrationSummaries.set(part.id, summary);
          // The handler may park on an approval, which names
          // this row; release it only once the row exists.
          yield* Deferred.succeed(callRowReady(part.id), {
            rowId,
            turnIndex: turn,
            callIndex: turnState.callIndex - 1,
          });
          // Named by the call when the chat has several; the result says which acted.
          const named = (args as { account?: unknown } | null)?.account;
          yield* start({
            family,
            name: part.name,
            integrationId: entry.integrationId,
            ...(typeof named === "string" && named.trim()
              ? { account: named.trim().slice(0, 120) }
              : {}),
            tool: entry.tool.name,
            label: entry.tool.label,
            access: entry.tool.access,
            summary,
          });
          return;
        }
        if (family === "image") {
          if (!imageModel) return;
          const shape = runningImageActivity(imageCallShape(imageModel, args));
          imageCalls.set(part.id, shape);
          // Previews name the call by this row, which the handler cannot know.
          yield* Deferred.succeed(callRowReady(part.id), {
            rowId,
            turnIndex: turn,
            callIndex: turnState.callIndex - 1,
            textOffset,
          });
          yield* start({
            family: "image",
            name: IMAGE_TOOL,
            model: shape.model,
            editing: shape.editing,
            ...(shape.aspectRatio ? { aspectRatio: shape.aspectRatio } : {}),
            count: shape.requested,
          });
          return;
        }
        if (family === "custom") {
          yield* start({
            family,
            name: part.name,
            displayName: customToolDisplayName(part.name),
          });
          return;
        }
        if (family === "skill") {
          const entry = config.skills?.find((skill) => skill.skillId === args["skillId"]);
          yield* start({
            family: "skill",
            name: part.name as typeof SkillToolName.Type,
            skillId: entry?.skillId ?? "",
            skillName: entry?.name ?? "Skill",
            path:
              part.name === "load_skill"
                ? "SKILL.md"
                : typeof args["path"] === "string"
                  ? args["path"].slice(0, 240)
                  : "",
          });
          return;
        }
        if (family === "knowledge") {
          const queries = Array.isArray(args["queries"]) ? args["queries"].map(String) : [];
          yield* start({
            family,
            name: part.name as typeof KnowledgeToolName.Type,
            ...(queries.length > 0 ? { targets: queries } : {}),
          });
          return;
        }

        const targets = Array.isArray(args["queries"])
          ? args["queries"].map(String)
          : Array.isArray(args["urls"])
            ? args["urls"].map(String)
            : [];
        yield* start({ family, name: part.name, args: { targets } });
        return;
      }
      case "tool-result": {
        const rowId = callRowIds.get(part.id);
        if (!rowId) return;
        if (part.name === "deep_research") {
          if (isPreliminary) return;
          const decoded = Schema.decodeUnknownOption(ResearchToolResult)(part.result);
          const result =
            !part.isFailure && Option.isSome(decoded)
              ? decoded.value
              : ({ outcome: "failed" } as ResearchToolResult);
          const run = result.runId && repo.research ? yield* repo.research.get(result.runId) : null;
          // Only evidence is a usable answer. A run that
          // produced none has already recorded why.
          const ok = result.outcome === "evidence";
          const failure = ok ? undefined : (result.message ?? "Research produced no evidence.");
          // The run wrote this row's body as it went. Settling
          // the call must not replace the progress and sources
          // the panel reads back on reload.
          yield* repo.settleToolCall({
            id: rowId,
            status: ok ? "complete" : "error",
            ...(failure ? { error: { code: "ResearchIncomplete", message: failure } } : {}),
          });
          if (run)
            yield* sink.pushTool({
              v: 1,
              family: "research",
              phase: "result",
              callId: rowId,
              runId: run.id,
              name: "deep_research",
              turnIndex: turn,
              callIndex: turnState.callIndex - 1,
              textOffset: callTextOffsets.get(part.id) ?? 0,
              progress: run.progress,
              ok,
              ...(failure ? { error: failure } : {}),
            });
          return;
        }
        for (const settle of SETTLED_FAMILIES) {
          const outcome = settle(part, rowId);
          if (!outcome) continue;
          if (isPreliminary) return;
          yield* repo.completeToolCall({
            id: rowId,
            result: json(outcome.result),
            status: outcome.ok ? "complete" : "error",
            ...(outcome.error ? { error: outcome.error } : {}),
          });
          yield* sink.pushTool(outcome.envelope);
          return;
        }
        if (Schema.is(DesktopToolName)(part.name)) {
          if (isPreliminary) return;
          const decoded = Schema.decodeUnknownOption(DesktopToolResult)(part.result);
          // Already capped and sniffed where it came in
          // (`acceptDesktopToolResult` in the submit function);
          // here it only has to be the shape the handler promised.
          const result: DesktopToolResult =
            !part.isFailure && Option.isSome(decoded)
              ? decoded.value
              : unusableDesktopResult(part.isFailure ? part.result : null);
          // Every file a machine tool returns becomes a working
          // file of this attempt, for other tools and for
          // publish_file, the only way one is stored. Anything
          // but an import is also shown to the model when it can
          // take that kind (docs/internals/files.md).
          const returned = result.ok ? result.file : undefined;
          const imported = part.name === "import_local_file";
          const created = returned
            ? yield* Effect.try({
                try: () =>
                  workingFiles.create({
                    bytes: new Uint8Array(Buffer.from(returned.base64, "base64")),
                    name: returned.name,
                    mediaType: returned.mediaType,
                    owner: "local",
                    capture: !imported,
                  }),
                catch: (error) => (error instanceof Error ? error.message : "Could not keep it."),
              }).pipe(
                Effect.map((file) => ({ reference: formatFileRef(file.ref) })),
                Effect.catch((failure) => Effect.succeed({ failure })),
              )
            : null;
          // A screenshot the model asked to show is delivered at
          // once, like any file the answer publishes.
          const shared =
            returned && sharedSnapshots.delete(part.id)
              ? yield* deliverFile(
                  {
                    name: returned.name,
                    mediaType: returned.mediaType,
                    bytes: new Uint8Array(Buffer.from(returned.base64, "base64")),
                  },
                  rowId,
                )
              : null;
          const { file: _bytes, ...rest } = result;
          const answer: DesktopToolResult =
            created && "reference" in created
              ? {
                  ...rest,
                  // First, not after a page's long outline: read there
                  // and kept in the row's excerpt.
                  detail: `${returnedLine(part.name, created.reference, shared)}\n${rest.detail}`,
                }
              : created && imported
                ? {
                    v: 1,
                    ok: false,
                    summary: "That file could not be imported",
                    detail: created.failure,
                    truncated: false,
                  }
                : imported && result.ok
                  ? {
                      v: 1,
                      ok: false,
                      summary: "That file could not be imported",
                      detail: result.detail,
                      truncated: false,
                    }
                  : created
                    ? {
                        ...rest,
                        detail: `${rest.detail}\n(It could not be kept for other tools or publishing: ${created.failure})`,
                      }
                    : rest;
          // The bytes leave the result first, so nothing below can
          // leave them in the prompt as text: the file part is
          // their only route to the model.
          Object.assign(part, { result: answer, encodedResult: answer });
          if (returned && !imported && attachmentKind(returned.mediaType) !== "file")
            turnFiles.push(
              yield* fileForModel(promptDeps.parser, {
                ...(created && "reference" in created ? { id: created.reference } : {}),
                fileName: returned.name,
                mediaType: returned.mediaType,
                bytes: Buffer.from(returned.base64, "base64"),
                vision: model?.capabilities.vision ?? false,
                files: model?.capabilities.files ?? false,
              }),
            );
          const stored = forTranscript(answer);
          // The model reads the full detail through the
          // prompt; the row and the chunk keep an excerpt.
          yield* repo.completeToolCall({
            id: rowId,
            result: json(stored),
            status: answer.ok ? "complete" : "error",
            ...(answer.ok
              ? {}
              : {
                  error: { code: "DesktopToolFailed", message: answer.summary },
                }),
          });
          yield* sink.pushTool({
            v: 1,
            family: "desktop",
            phase: "result",
            callId: rowId,
            name: part.name,
            result: stored,
          });
          return;
        }
        if (part.name === "ask_user") {
          if (isPreliminary) return;
          const decoded = Schema.decodeUnknownOption(AskUserResult)(part.result);
          const result: AskUserResult =
            !part.isFailure && Option.isSome(decoded)
              ? decoded.value
              : {
                  v: 1,
                  outcome: "rejected",
                  message: "Questions could not be presented.",
                };
          const ok = result.outcome === "presented";
          yield* repo.completeToolCall({
            id: rowId,
            result: json(result),
            status: ok ? "complete" : "error",
            ...(ok ? {} : { error: { code: "QuestionRejected", message: result.message } }),
          });
          yield* sink.pushTool({
            v: 1,
            family: "ask",
            phase: "result",
            callId: rowId,
            name: part.name,
            result,
          });
          if (ok) state.questionPresented = true;
          return;
        }
        const office = officeFamilyOf(part.name);
        if (office) {
          if (isPreliminary) return;
          const activity = office.summary(part.result, part.isFailure);
          const { outcome, message } = activity;
          yield* repo.completeToolCall({
            id: rowId,
            result: json(activity),
            status: outcome === "error" ? "error" : "complete",
            ...(outcome === "error" ? { error: { code: office.failure, message } } : {}),
          });
          yield* sink.pushTool({
            v: 1,
            family: office.family,
            phase: "result",
            callId: rowId,
            name: part.name,
            ...activity,
          } as ToolChunkEnvelope);
          return;
        }
        if (
          (part.name === "publish_file" && publishFileTool) ||
          (part.name === "create_file" && createFileTool)
        ) {
          if (isPreliminary) return;
          const pending = fileDelivery.take(part.id);
          const raw = Option.getOrUndefined(
            Schema.decodeUnknownOption(ToolFileActivity)(part.result),
          );
          let attachmentId = raw?.attachmentId;
          let error = raw?.error;
          if (pending) {
            if (part.isFailure) {
              error = "File publication was interrupted.";
            } else if (
              pending.file.source !== undefined &&
              !(toolFiles && (yield* toolFiles.authorize(pending.file.source)))
            ) {
              error = "The file this draft was opened from is no longer available.";
            } else {
              const delivered = yield* deliverFile(
                { ...pending.file, name: pending.name },
                rowId,
                // Delivered and no longer a draft, in one commit.
                keptFiles ? (tx, owner) => keptFiles.consume(tx, owner, pending.ref.id) : undefined,
              );
              if ("attachment" in delivered) attachmentId = delivered.attachment.id;
              else error = delivered.reason;
            }
            workingFiles.finishPublish(pending.ref, attachmentId);
          }
          const ok = !part.isFailure && !error && !!attachmentId;
          const publishedRef = raw?.ref ? parseFileRef(raw.ref) : null;
          const workingFileId = publishedRef?.kind === "working" ? publishedRef.id : undefined;
          const result: ToolFileActivity = {
            ok,
            ...(raw?.ref ? { ref: raw.ref } : {}),
            ...(workingFileId ? { workingFileId } : {}),
            ...(attachmentId ? { attachmentId } : {}),
            ...(!ok ? { error: error ?? "Publication failed." } : {}),
          };
          Object.assign(part, { result, encodedResult: result });
          yield* repo.completeToolCall({
            id: rowId,
            result: json(result),
            status: ok ? "complete" : "error",
            ...(!ok
              ? {
                  error: {
                    code: "PublicationFailed",
                    message: result.error ?? "Publication failed.",
                  },
                }
              : {}),
          });
          yield* sink.pushTool({
            v: 1,
            family: "tool-file",
            phase: "result",
            callId: rowId,
            name: part.name === "create_file" ? "create_file" : "publish_file",
            ...result,
          });
          return;
        }
        if (part.name === "read_attachment") {
          if (isPreliminary) return;
          // The text went to the model; the row keeps which part was read.
          const activity = part.isFailure
            ? { ok: false, error: "The file could not be read." }
            : attachmentReadActivity(part.result);
          yield* repo.completeToolCall({
            id: rowId,
            result: json(activity),
            status: activity.ok ? "complete" : "error",
            ...(activity.ok
              ? {}
              : {
                  error: {
                    code: "AttachmentReadFailed",
                    message: activity.error ?? "The file could not be read.",
                  },
                }),
          });
          yield* sink.pushTool({
            v: 1,
            family: "attachment",
            phase: "result",
            callId: rowId,
            name: "read_attachment",
            ...activity,
          });
          return;
        }
        if (Schema.is(HistoryToolName)(part.name)) {
          if (isPreliminary) return;
          // The text went to the model; the row keeps what was looked for.
          const activity = part.isFailure
            ? { ok: false, error: "The history could not be read." }
            : historyActivity(part.result);
          yield* repo.completeToolCall({
            id: rowId,
            result: json(activity),
            status: activity.ok ? "complete" : "error",
            ...(activity.ok
              ? {}
              : {
                  error: {
                    code: "HistoryReadFailed",
                    message: activity.error ?? "The history could not be read.",
                  },
                }),
          });
          yield* sink.pushTool({
            v: 1,
            family: "history",
            phase: "result",
            callId: rowId,
            name: part.name,
            ...activity,
          });
          return;
        }
        if (part.name === "load_tools") {
          if (isPreliminary) return;
          const decoded = Schema.decodeUnknownOption(LoadToolsResult)(part.result);
          const ok = !part.isFailure && Option.isSome(decoded);
          yield* repo.completeToolCall({
            id: rowId,
            result: ok ? json(decoded.value) : null,
            status: ok ? "complete" : "error",
            ...(ok
              ? {}
              : {
                  error: {
                    code: "ToolLoadFailed",
                    message: "The tools could not be loaded.",
                  },
                }),
          });
          yield* sink.pushTool({
            v: 1,
            family: "tool-load",
            phase: "result",
            callId: rowId,
            name: "load_tools",
            ok,
            ...(ok ? { loaded: decoded.value.loaded } : {}),
          });
          return;
        }
        if (part.name === "update_plan") {
          if (isPreliminary) return;
          const decoded = Schema.decodeUnknownOption(PlanToolResult)(part.result);
          const result: PlanToolResult =
            !part.isFailure && Option.isSome(decoded)
              ? decoded.value
              : {
                  v: 1,
                  outcome: "rejected",
                  message: "The checklist could not be updated.",
                };
          const ok = result.outcome === "updated";
          // Durable activity retains this accepted revision; only
          // the model continuation compacts old lists.
          yield* repo.completeToolCall({
            id: rowId,
            result: json(result),
            status: ok ? "complete" : "error",
            ...(ok ? {} : { error: { code: "PlanRejected", message: result.message } }),
          });
          yield* sink.pushTool({
            v: 1,
            family: "plan",
            phase: "result",
            callId: rowId,
            name: "update_plan",
            ok,
            ...(ok ? { steps: result.steps } : { error: result.message }),
          });
          return;
        }
        if (part.name === "notify_user" && notifyTools) {
          if (isPreliminary) return;
          const decoded = Schema.decodeUnknownOption(NotifyToolResult)(part.result);
          const result: NotifyToolResult =
            !part.isFailure && Option.isSome(decoded)
              ? decoded.value
              : { v: 1, outcome: "rejected", message: "Nothing was sent." };
          const ok = result.outcome === "queued";
          yield* repo.completeToolCall({
            id: rowId,
            result: json(result),
            status: ok ? "complete" : "error",
            ...(ok ? {} : { error: { code: "NotifyRejected", message: result.message } }),
          });
          yield* sink.pushTool({
            v: 1,
            family: "notify",
            phase: "result",
            callId: rowId,
            name: "notify_user",
            ok,
            ...(ok ? { message: result.message } : { error: result.message }),
          });
          return;
        }
        if (part.name === MAP_ROUTE_TOOL && mapRouteTools) {
          if (isPreliminary) return;
          const decoded = Schema.decodeUnknownOption(MapRouteResult)(part.result);
          const result: MapRouteResult =
            !part.isFailure && Option.isSome(decoded)
              ? decoded.value
              : { v: 1, outcome: "rejected", message: "No route was found." };
          const summary = summarizeMapRoute(result);
          const ok = summary !== null;
          yield* repo.completeToolCall({
            id: rowId,
            result: json(result),
            status: ok ? "complete" : "error",
            ...(result.outcome === "rejected"
              ? { error: { code: "RouteNotFound", message: result.message } }
              : {}),
          });
          yield* sink.pushTool({
            v: 1,
            family: "map",
            phase: "result",
            callId: rowId,
            name: MAP_ROUTE_TOOL,
            ok,
            ...(summary
              ? { route: summary }
              : { error: result.outcome === "rejected" ? result.message : "" }),
          });
          return;
        }
        if (part.name === "save_memory") {
          // Memory handlers have no preliminary progress. Ignore
          // any malformed preliminary part rather than persisting
          // a second activity shape for this family.
          if (isPreliminary) return;
          const decodedMemory = Schema.decodeUnknownOption(SaveMemoryResult)(part.result);
          const result = Option.getOrUndefined(decodedMemory);
          const outcome = result?.outcome ?? "rejected";
          const reason = result?.reason;
          const scope = result?.scope === "project" ? { scope: "project" as const } : {};
          const ok = !part.isFailure && result?.ok === true;
          yield* repo.completeToolCall({
            id: rowId,
            result: { outcome, ...(reason ? { reason } : {}), ...scope },
            status: ok ? "complete" : "error",
            ...(ok
              ? {}
              : {
                  error: {
                    code: "MemoryNotSaved",
                    message: "memory was not saved",
                  },
                }),
          });
          yield* sink.pushTool({
            v: 1,
            family: "memory",
            phase: "result",
            callId: rowId,
            name: part.name,
            ok,
            outcome,
            ...(reason ? { reason } : {}),
            ...scope,
            ...(ok ? {} : { error: "memory was not saved" }),
          });
          return;
        }

        if (Schema.is(SkillToolName)(part.name)) {
          if (isPreliminary) return;
          const activity = projectSkillToolResult(part.name, part.result) ?? {
            family: "skill" as const,
            version: 1 as const,
            name: part.name,
            skillId: "",
            skillName: "Skill",
            path: "",
            status: "error" as const,
            error: "Skill tool failed.",
          };
          yield* repo.completeToolCall({
            id: rowId,
            result: json(activity),
            status: activity.status === "complete" ? "complete" : "error",
          });
          yield* sink.pushTool({
            v: 1,
            phase: "result",
            callId: rowId,
            ...activity,
          });
          return;
        }
        if (Schema.is(KnowledgeToolName)(part.name)) {
          if (isPreliminary) return;
          const activity = projectKnowledgeToolResult(
            part.result,
            part.isFailure,
            knowledgeTools?.remaining() ?? 0,
          );
          for (const source of activity.sources)
            sourcesByIndex.set(source.index, mergeSource(sourcesByIndex.get(source.index), source));
          yield* repo.completeToolCall({
            id: rowId,
            result: json(activity),
            status: activity.ok ? "complete" : "error",
            ...(activity.ok
              ? {}
              : {
                  error: {
                    code: "ToolFailed",
                    message: activity.error ?? "knowledge tool failed",
                  },
                }),
          });
          yield* sink.pushTool({
            v: 1,
            phase: "result",
            callId: rowId,
            name: part.name,
            ...activity,
          });
          return;
        }

        const integrationEntry = integrationTools?.names.get(part.name);
        if (integrationEntry) {
          if (isPreliminary) return;
          const { sources, access, files, decided, account } = integrationTools!.take(part.id);
          // Files a service returned become attachments of the answer,
          // stored under the fence like a custom tool's; a failed one is noted.
          // By position: the result lists the files in the order returned,
          // and two may share a name.
          const undelivered = new Map<number, string>();
          for (const [index, file] of files.entries()) {
            const stored = yield* deliverFile(file, rowId);
            if ("reason" in stored) {
              undelivered.set(index, stored.reason.slice(0, 200));
              continue;
            }
            turnFiles.push(
              yield* fileForModel(promptDeps.parser, {
                id: stored.attachment.id,
                fileName: file.name,
                mediaType: stored.attachment.mediaType,
                bytes: file.bytes,
                vision: model?.capabilities.vision ?? false,
                files: model?.capabilities.files ?? false,
              }),
            );
          }
          // The result already names each file; mark the ones that did not arrive.
          const returned = part.result as { ok?: unknown; result?: unknown };
          const output = returned.result as { files?: unknown } | null | undefined;
          if (undelivered.size && returned.ok === true && output && Array.isArray(output.files)) {
            const noted = {
              ...returned,
              result: {
                ...output,
                files: output.files.map((entry: object, index: number) =>
                  undelivered.has(index)
                    ? { ...entry, notAttached: undelivered.get(index) }
                    : entry,
                ),
              },
            };
            Object.assign(part, { result: noted, encodedResult: noted });
          }
          for (const source of sources)
            sourcesByIndex.set(source.index, mergeSource(sourcesByIndex.get(source.index), source));
          const activity = projectIntegrationToolResult({
            name: part.name,
            integrationId: integrationEntry.integrationId,
            // Only when the call had a choice; one account needs no naming.
            account: integrationEntry.chooses ? (account?.name ?? null) : null,
            tool: integrationEntry.tool.name,
            label: integrationEntry.tool.label,
            // A call that reached people is recorded as destructive.
            access: access ?? integrationEntry.tool.access,
            summary: integrationSummaries.get(part.id) ?? null,
            raw: part.result,
            isFailure: part.isFailure,
            sources,
            decided,
          });
          yield* repo.completeToolCall({
            id: rowId,
            result: json(activity),
            status: activity.status === "complete" ? "complete" : "error",
            ...(activity.error
              ? {
                  error: {
                    code:
                      activity.status === "refused" ? "IntegrationRefused" : "IntegrationFailed",
                    message: activity.error,
                  },
                }
              : {}),
          });
          yield* sink.pushTool({
            v: 1,
            family: "integration",
            phase: "result",
            callId: rowId,
            name: part.name,
            activity,
          });
          return;
        }

        if (part.name === IMAGE_TOOL && imageTool && imageModel) {
          if (isPreliminary) return;
          const raw = (part.result ?? {}) as {
            ok?: boolean;
            quality?: ImageQuality;
            adjustments?: ReadonlyArray<string>;
            refusal?: string;
            error?: string;
          };
          const shape =
            imageCalls.get(part.id) ?? runningImageActivity(imageCallShape(imageModel, {}));
          imageCalls.delete(part.id);
          sink.clearPreview(rowId);
          const staged = imageTool.take(part.id);
          const attachmentIds: string[] = [];
          const failures: string[] = [];
          const images = staged?.images ?? [];
          for (const [index, image] of images.entries()) {
            const extension = image.mediaType.split("/")[1] ?? "png";
            const stored = yield* deliverFile(
              {
                // Numbered only when the call made several.
                name: `${staged?.stem ?? "image"}${images.length > 1 ? `-${index + 1}` : ""}.${extension === "jpeg" ? "jpg" : extension}`,
                mediaType: image.mediaType,
                bytes: image.data,
                fileSource: "image-tool",
                // Its slot was granted before it drew: kept even if the
                // model's own images filled the count since.
                reserved: true,
              },
              rowId,
            );
            if ("reason" in stored) {
              failures.push(stored.reason);
              continue;
            }
            attachmentIds.push(stored.attachment.id);
            // Vision models see what they made, once, like any file.
            turnFiles.push(
              yield* fileForModel(promptDeps.parser, {
                id: stored.attachment.id,
                fileName: stored.attachment.fileName,
                mediaType: stored.attachment.mediaType,
                bytes: image.data,
                vision: model?.capabilities.vision ?? false,
                files: model?.capabilities.files ?? false,
              }),
            );
          }
          staged?.settle(attachmentIds.length);
          // Some kept and some not: the call succeeded, but the paid-for
          // images it lost are said, first, so the caption never drops it.
          const adjustments =
            attachmentIds.length > 0 && failures.length > 0
              ? [
                  `${failures.length} of ${failures.length + attachmentIds.length} images could not be kept: ${failures[0]}`,
                  ...(raw.adjustments ?? []),
                ]
              : raw.adjustments;
          const error =
            raw.error ??
            (staged && attachmentIds.length === 0
              ? (failures[0] ?? "The images could not be stored.")
              : undefined);
          if (staged) {
            const delivered = {
              ...raw,
              ...(attachmentIds.length === 0 ? { ok: false } : {}),
              ...(error ? { error } : {}),
              ...(adjustments ? { adjustments } : {}),
              images: attachmentIds.length,
              attachmentIds,
              files: attachmentIds.map((id) => formatFileRef({ kind: "attachment", id })),
            };
            Object.assign(part, { result: delivered, encodedResult: delivered });
          }
          const activity = imageActivity({
            ...shape,
            attachmentIds,
            quality: raw.quality,
            adjustments,
            refusal: raw.refusal,
            error: part.isFailure ? "The image tool failed." : raw.refusal ? undefined : error,
          });
          yield* repo.completeToolCall({
            id: rowId,
            result: json(activity),
            status: activity.status,
            ...(activity.status === "error"
              ? {
                  error: {
                    code: activity.refusal ? "ImageRefused" : "ImageFailed",
                    message: activity.refusal ?? activity.error ?? "No image was made.",
                  },
                }
              : {}),
          });
          yield* sink.pushTool({
            v: 1,
            phase: "result",
            callId: rowId,
            name: IMAGE_TOOL,
            ...activity,
          });
          return;
        }

        if (customToolNames.has(part.name)) {
          if (isPreliminary) return;
          const fileIds: string[] = [];
          const workingOutputs: Array<{
            id: string;
            revision: number;
            name: string;
          }> = [];
          const outcomes: Array<Record<string, unknown>> = [];
          const errors: string[] = [];
          const owner = customToolOwners.get(part.name)!;
          for (const item of customTools?.takeFiles(part.id) ?? []) {
            if (item.delivery === "working") {
              const committed = yield* Effect.try({
                try: () =>
                  item.replaces
                    ? workingFiles.replace(item.replaces, { ...item, owner })
                    : workingFiles.create({ ...item, owner }),
                catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
              }).pipe(Effect.result);
              if (committed._tag === "Failure") {
                errors.push(`${item.name}: ${committed.failure}`);
                outcomes.push({ error: committed.failure });
                continue;
              }
              const ref = formatFileRef(committed.success.ref);
              workingOutputs.push({
                id: committed.success.ref.id,
                revision: committed.success.ref.revision,
                name: item.name,
              });
              outcomes.push({ ref, revision: committed.success.ref.revision });
              if (item.showModel)
                turnFiles.push(
                  yield* fileForModel(promptDeps.parser, {
                    id: ref,
                    fileName: item.name,
                    mediaType: committed.success.mediaType,
                    bytes: item.bytes,
                    vision: model?.capabilities.vision ?? false,
                    files: model?.capabilities.files ?? false,
                  }),
                );
              continue;
            }
            const stored = yield* deliverFile(item, rowId);
            if ("reason" in stored) {
              errors.push(`${item.name}: ${stored.reason}`);
              outcomes.push({ error: stored.reason });
              continue;
            }
            fileIds.push(stored.attachment.id);
            outcomes.push({
              attachmentId: stored.attachment.id,
              ref: formatFileRef({
                kind: "attachment",
                id: stored.attachment.id,
              }),
            });
            if (item.showModel)
              turnFiles.push(
                yield* fileForModel(promptDeps.parser, {
                  id: stored.attachment.id,
                  fileName: item.name,
                  mediaType: stored.attachment.mediaType,
                  bytes: item.bytes,
                  vision: model?.capabilities.vision ?? false,
                  files: model?.capabilities.files ?? false,
                }),
              );
          }
          if (outcomes.length > 0) {
            const result = part.result as {
              files?: ReadonlyArray<{ name: string }>;
            };
            const delivered = {
              ...result,
              ...(errors.length ? { ok: false, error: errors.join("; ").slice(0, 500) } : {}),
              files: (result.files ?? []).map((file, index) => ({
                ...file,
                ...outcomes[index],
              })),
            };
            Object.assign(part, { result: delivered, encodedResult: delivered });
          }
          const activity = projectCustomToolResult({
            name: part.name,
            displayName: customToolDisplayName(part.name),
            raw: part.result,
            isFailure: part.isFailure,
            fileIds,
            workingFiles: workingOutputs,
          });
          yield* repo.completeToolCall({
            id: rowId,
            result: json(activity),
            status: activity.status === "complete" ? "complete" : "error",
            ...(activity.error
              ? { error: { code: "CustomToolFailed", message: activity.error } }
              : {}),
          });
          yield* sink.pushTool({
            v: 1,
            family: "custom",
            phase: "result",
            callId: rowId,
            name: part.name,
            displayName: activity.displayName,
            status: activity.status === "complete" ? "complete" : "error",
            ...(activity.resultPreview !== undefined
              ? { resultPreview: activity.resultPreview }
              : {}),
            ...(activity.resultChars !== undefined ? { resultChars: activity.resultChars } : {}),
            ...(activity.error ? { error: activity.error } : {}),
            ...(activity.fileIds ? { fileIds: activity.fileIds } : {}),
            ...(activity.workingFiles ? { workingFiles: activity.workingFiles } : {}),
          });
          return;
        }

        const result = part.result as Partial<WebToolResult> | null;
        const pages = result?.pages ?? [];
        const sources = result?.sources ?? [];
        const failures = result?.failures ?? [];

        if (!isPreliminary) {
          for (const source of sources) {
            sourcesByIndex.set(source.index, mergeSource(sourcesByIndex.get(source.index), source));
          }
        }

        if (isPreliminary) {
          // Live progress: hits found / page fetch transitions.
          yield* sink.pushTool({
            v: 1,
            family: "web",
            phase: "progress",
            callId: rowId,
            name: part.name,
            summary: {
              targets: result?.targets ?? [],
              ...(result?.resultCount !== undefined ? { resultCount: result.resultCount } : {}),
              ...(result?.pagesFetched !== undefined ? { pagesFetched: result.pagesFetched } : {}),
            },
            pages,
          });
          return;
        }

        const ok = !part.isFailure && result?.ok !== false;
        // Persist summary + source list only, never page bodies.
        const summary = {
          targets: result?.targets ?? [],
          ...(result?.resultCount !== undefined ? { resultCount: result.resultCount } : {}),
          ...(result?.pagesFetched !== undefined ? { pagesFetched: result.pagesFetched } : {}),
        };
        yield* repo.completeToolCall({
          id: rowId,
          result: json({
            ...summary,
            ...(pages.length > 0 ? { pages } : {}),
            ...(sources.length > 0 ? { sources } : {}),
            ...(failures.length > 0 ? { failures } : {}),
          }),
          status: ok ? "complete" : "error",
          ...(ok
            ? {}
            : {
                error: {
                  code: "ToolFailed",
                  message: result?.error ?? "tool execution failed",
                },
              }),
        });
        yield* sink.pushTool({
          v: 1,
          family: "web",
          phase: "result",
          callId: rowId,
          name: part.name,
          ok,
          summary,
          ...(pages.length > 0 ? { pages } : {}),
          ...(sources.length > 0 ? { sources } : {}),
          ...(failures.length > 0 ? { failures } : {}),
          ...(ok ? {} : { error: result?.error ?? "tool execution failed" }),
        });
        return;
      }
      case "finish": {
        turnState.finishReason = part.reason;
        addFinishUsage(usage.totals, part);
        usage.modelCallOpen = false;
        if (imageOutput && providerCostOf(part.metadata) === null) usage.imageCostIncomplete = true;
        // The round's opaque reasoning state, kept with the
        // answer so its history replays it to the same model.
        const unit = replayUnitOf(replayOf(part.metadata));
        if (model && (unit || imageOutput)) {
          const next = appendReplay(state.replay, {
            turnIndex: turn,
            startOffset: turnStartOffset,
            endOffset: sink.text().length,
            unit,
          });
          if (next && next !== state.replay) {
            state.replay = next;
            yield* repo.saveProviderReplay(input.messageId, next);
          }
        }
        if (!usage.sawFirstFinish) {
          usage.sawFirstFinish = true;
          usage.firstInputTokens = part.usage.inputTokens.total;
        }
        return;
      }
      case "error": {
        return yield* Effect.fail(part.error);
      }
      // An edit_document call's arguments, as they stream: the
      // open document shows the edit being written. The
      // decoded call settles it.
      case "tool-params-start":
        documents.live.start(part.id, part.name);
        // An Office edit or a research brief is a call the model
        // can spend a while writing; say so before it completes.
        if (
          officeFamilyOfEdit(part.name) ||
          part.name === "deep_research" ||
          isDocumentWrite(part.name)
        ) {
          sink.push(
            "writing",
            JSON.stringify({
              v: 1,
              id: part.id,
              name: part.name,
              textOffset: sink.text().length,
              turnIndex: turn,
              // A resumed answer replays this chunk; the attempt
              // it names tells the client it is no longer writing.
              ...(fence ? { runId: fence.generationId } : {}),
            }),
          );
          yield* sink.flush;
        }
        return;
      case "tool-params-delta":
        yield* documents.live.delta(part.id, part.delta);
        return;
      default:
        return;
    }
  });
