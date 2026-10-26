import type { Localized } from "~/i18n/localized.ts";
import type { WordDocumentFile } from "~/modules/documents/server/document-tools.ts";
import { readWordDocument } from "~/modules/documents/server/word-import.ts";
import { prepareDocumentTools } from "~/modules/documents/server/document-tools.ts";
import { projectCan } from "~/modules/projects/schema.ts";
import { prepareProjectFileTools } from "~/modules/projects/server/file-tools.ts";
import { prepareResearchTool, researchAvailable, type ToolCallRowRef } from "../research/tool.ts";

import { prepareAgentDraftTools } from "~/modules/agents/server/authoring-tools.ts";
import { prepareScheduleDraftTools } from "~/modules/schedules/server/authoring-tools.ts";
import { SkillReader } from "~/modules/skills/server/reader.ts";
import { prepareSkillTools, skillOffer } from "~/modules/skills/server/tools.ts";
import { findBuiltinSkill } from "~/modules/skills/bundled/index.ts";
import type { FontFace } from "~/modules/presentations/server/font-file.ts";
import { sha256Hex } from "~/modules/attachments/server/sha256.ts";
import {
  isOfficeFamily,
  OFFICE_FAMILIES,
  officeFamilyOfFile,
  officeFamilyOfTool,
} from "~/modules/office/families.ts";
import { prepareOfficeTools, runnableOfficeFamilies } from "~/modules/office/server/families.ts";
import { attachmentKind } from "~/modules/attachments/constants.ts";
import { acceptSearchImage } from "../generated-files.ts";
import {
  INTERACTIVE_UI_TOOL,
  MAPS_TOOL,
  readInteractiveUi,
  readMaps,
} from "~/modules/genui/settings.ts";
import { INTERACTIVE_UI_SKILL_ID } from "~/modules/genui/skill.ts";
import { makeImageResolver, type ImageResolver } from "~/modules/genui/server/image-resolver.ts";
import { makeMapResolver, type MapResolver } from "~/modules/genui/server/map-resolver.ts";
import { prepareMapRouteTool } from "~/modules/genui/server/map-tool.ts";
import { fileForModel } from "../file-for-model.ts";
import { ensureGenerationLive, lockGeneration } from "../generation-fence.ts";
import { prepareConversationContext } from "../conversation-context.ts";
import { Deferred, Effect, Option, Schema } from "effect";
import { english } from "~/i18n/localized.ts";
import { prepareAskUserTool } from "~/modules/tools/server/ask-user.ts";
import { prepareDesktopTools } from "~/modules/desktop/server/tools.ts";
import { preparePlanTool } from "~/modules/tools/server/plan-tool.ts";
import { PlanSnapshot } from "~/modules/tools/plan-schema.ts";
import { Prompt } from "effect/ai";
import { makeToolFileResolver } from "../tool-files.ts";
import { createWorkingFiles, type WorkingFiles } from "../working-files.ts";
import { formatFileRef } from "../file-ref.ts";
import { preparePublishFileTool } from "../publish-file.ts";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import { prepareKnowledgeTools } from "~/modules/knowledge/server/tools.ts";
import { KnowledgeToolName } from "~/modules/knowledge/tool-schema.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { loadImageModel } from "~/modules/images/server/descriptor.ts";
import {
  imageModelNote,
  makeImageBudget,
  prepareImageTool,
} from "~/modules/images/server/image-tool.ts";
import {
  ASSISTANT_FILE_LIMITS as ANSWER_FILE_LIMITS,
  isGeneratedImage,
} from "../../assistant-output.ts";
import { prepareIntegrationTools } from "~/modules/integrations/server/tools.ts";
import { prepareCustomTools } from "~/modules/custom-tools/server/tools.ts";
import { createSourceIndexer } from "~/modules/tools/server/source-indexer.ts";
import { mergeToolGroups, prepareWebTools, toolFamilies } from "~/modules/tools/server/toolset.ts";
import type { ToolFamily } from "~/modules/tools/families.ts";
import { createUrlAuthority } from "~/modules/tools/server/url-authority.ts";
import { prepareBrowserTools } from "~/modules/browser/server/tools.ts";
import { findScheduleFire, prepareNotifyTool } from "~/modules/schedules/server/notify-tool.ts";

import { isWebSource } from "~/modules/tools/sources.ts";
import { computeBudget, skillRootChars, estimateToolSchemaTokens } from "../compaction.ts";
import { type PromptDeps } from "../prompt.ts";
import { prepareAttachmentReader } from "../attachment-reader.ts";
import { prepareHistoryTools } from "../history-tools.ts";
import { currentAttachmentId } from "../file-aliases.ts";
import { hasFileText } from "~/modules/attachments/server/file-text.ts";
import {
  fixedFamilySummary,
  isAdvertised,
  lazyFamilyOfTool,
  prepareToolLoad,
} from "~/modules/tools/server/tool-load.ts";
import {
  LazyToolFamily,
  LoadToolsResult,
  type LoadableToolFamily,
} from "~/modules/tools/tool-load-schema.ts";
import type { AttemptContext, GenerationInput } from "./attempt-context.ts";
import type { GenerationDeps } from "./deps.ts";
import type { GenerationSink } from "./sink.ts";
import type { DbTx } from "~/server/db.ts";

/** Faces one answer's loaded skills may add to its previews. */
const SKILL_FONT_FACES = 24;
/** Slide images one answer may put in front of the model, which it pays for per round. */
const PREVIEW_FEEDBACK_LIMITS = { slides: 256, bytes: 128 * 1024 * 1024 } as const;
/** A file name inside a policy or reminder block is data: quoted, and unable to close the block. */
export const quotedName = (name: string) => JSON.stringify(name.replace(/[<>]/g, ""));

/**
 * Builds every tool family this attempt is offered, in the order their
 * preparation reads and writes, and the state the rounds share with them:
 * which lazy families are loaded and whether the reader and retrieval are
 * advertised. Scoped to the attempt: working files are kept as it closes.
 */
export const prepareGenerationTools = (
  deps: GenerationDeps,
  input: GenerationInput,
  ctx: AttemptContext,
  sink: GenerationSink,
  promptDeps: PromptDeps,
) =>
  Effect.gen(function* () {
    const {
      repo,
      gateway,
      webSearch,
      urlReader,
      providers,
      authoringServices,
      scheduleAuthoringServices,
      documentService,
      analytics,
      memory,
      projectMemory,
      knowledgeSearch,
      knowledgeService,
      skillReader,
      customToolRuntime,
      processors,
      presentationFonts,
      toolRegistry,
      limits,
      integrations,
      integrationApprovals,
      imageAttachments,
      mapLookups,
      imageFetcher,
      projectFiles,
      database,
      keptFiles,
    } = deps;
    const {
      fence,
      currentMessage,
      config,
      permissions,
      customToolManifests,
      integrationOffer,
      model,
      resuming,
      ownCalls,
      ownSteers,
      ownFiles,
      completed,
      readerUrls,
      priorToolCalls,
      priorSources,
      priorUsage,
    } = ctx;
    const writeGuard = (tx: DbTx) => (fence ? lockGeneration(tx, fence) : Effect.interrupt);
    const authoring = yield* prepareAgentDraftTools({
      services: authoringServices,
      userId: input.userId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      currentModelId: input.modelId,
      writeGuard,
    });
    const scheduleAuthoring = yield* prepareScheduleDraftTools({
      services: scheduleAuthoringServices,
      userId: input.userId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      currentModelId: input.modelId,
      timeZone: input.timeZone,
      writeGuard,
    });
    // Set once the attempt's file resolver exists, below; a call reads it when it runs.
    let wordFiles:
      | ((reference: string) => Effect.Effect<WordDocumentFile, Localized | string>)
      | null = null;
    const documents = yield* prepareDocumentTools({
      service: documentService,
      readWordFile: (reference) =>
        wordFiles ? wordFiles(reference) : Effect.fail("Files cannot be read in this chat."),
      userId: input.userId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      openDocumentId: input.openDocument?.id,
      selectedBlocks: input.openDocument?.selected,
      askingThread: input.openDocument?.thread,
      writeGuard,
      liveGuard: (tx: DbTx) => (fence ? ensureGenerationLive(tx, fence) : Effect.interrupt),
      project: config.resolvedProject
        ? {
            id: config.resolvedProject.id,
            name: config.resolvedProject.name,
            canEdit: projectCan.edit(config.resolvedProject.role),
          }
        : null,
    });
    // Only in a project chat, and only for an answer that can be fenced.
    const projectFileTools =
      config.resolvedProject && fence && Option.isSome(projectFiles)
        ? prepareProjectFileTools({
            service: projectFiles.value,
            userId: input.userId,
            conversationId: input.conversationId,
            generationId: fence.generationId,
            project: {
              id: config.resolvedProject.id,
              canEdit: projectCan.edit(config.resolvedProject.role),
            },
            writeGuard,
          })
        : null;
    // One indexer and one URL authority for the whole generation. Search
    // hits extend the reader's authority immediately, while user URLs and
    // earlier persisted sources seed it for direct reads and follow-ups.
    const authority = createUrlAuthority([
      ...readerUrls,
      ...priorSources.filter(isWebSource).map((source) => source.url),
    ]);
    const indexer = createSourceIndexer(priorSources);
    // Every chat model takes tools: the gateway polyfills prompt-based
    // calling for models without native support (`hermes-tools.ts`).
    const webTools = permissions.webSearch
      ? yield* prepareWebTools({
          webSearch,
          urlReader,
          indexer,
          authority,
          requestSearch: config.searchEnabled,
          owner: input.userId,
        })
      : null;

    // Admins can switch interactive answers, or only their images, off in
    // Tools, and maps apart from both. Read once per attempt, so a change
    // applies to the next answer.
    const interactiveUi = readInteractiveUi(yield* toolRegistry.getTool(INTERACTIVE_UI_TOOL));
    const maps = readMaps(yield* toolRegistry.getTool(MAPS_TOOL));
    // Images named by the answer's ```ui blocks, looked up while it streams.
    // Only with the search this attempt was offered; otherwise each query
    // is recorded as needing it, so the reader is told why.
    const imageResolver: ImageResolver | null =
      interactiveUi.images && fence && Option.isSome(imageAttachments)
        ? yield* makeImageResolver({
            searchOn: permissions.webSearch && config.searchEnabled,
            settled: new Set(
              Object.keys((resuming && currentMessage?.assistantOutput?.images) || {}),
            ),
            search: (query, maxResults) => webSearch.images(query, maxResults),
            fetch: (url) => imageFetcher.fetch(url),
            store: (image, fileName) =>
              acceptSearchImage(imageAttachments.value, {
                fence,
                fileName,
                mediaType: image.mediaType,
                bytes: image.bytes,
              }),
            record: (query, result) => sink.recordLookups(fence, { images: { [query]: result } }),
          })
        : null;
    if (imageResolver) yield* imageResolver.observe(sink.text());
    // Places and routes on the answer's maps. Not web search: they go to
    // the map services an admin configured, and only place names leave.
    const earlier = (resuming && currentMessage?.assistantOutput) || null;
    // With maps off nothing is asked, but each place is marked so, so the
    // reader is told why rather than that it could not be found.
    const mapResolver: MapResolver | null =
      fence && Option.isSome(mapLookups)
        ? yield* makeMapResolver({
            off: !maps.enabled,
            settled: {
              places: new Set(Object.keys(earlier?.places ?? {})),
              routes: new Set(Object.keys(earlier?.routes ?? {})),
            },
            known: new Map(
              Object.entries(earlier?.places ?? {}).filter(
                ([, place]) => place.status === "resolved",
              ),
            ),
            geocode: (query) => mapLookups.value.geocode(maps.services, query),
            route: (mode, stops) => mapLookups.value.route(maps.services, mode, stops),
            record: (update) => sink.recordLookups(fence, update),
          })
        : null;
    if (mapResolver) yield* mapResolver.observe(sink.text());

    // Knowledge: one authorized session over the saved manifest for the
    // whole generation. Access loss anywhere fails the generation rather
    // than answering from the part that remains. The session is scoped
    // to `generate`, so a stopped answer closes it.
    const knowledgeSession =
      config.knowledgeMode !== "none"
        ? yield* knowledgeSearch.session({
            userId: input.userId,
            collectionIds: config.collectionIds,
            manifest: config.manifest,
          })
        : null;
    // Selected and agent-attached skills are pinned by the attempt; the
    // rest of the reader's library is offered as metadata so the model
    // can find a relevant skill without being told to use it.
    const skillManifest = yield* skillOffer(skillReader, {
      userId: input.userId,
      pinned: config.skills ?? [],
      // Switched off, the skill is not offered; blocks already in
      // earlier answers still render.
      leaveOut: interactiveUi.enabled ? [] : [INTERACTIVE_UI_SKILL_ID],
    });
    const skillTools = skillManifest.length
      ? yield* prepareSkillTools({
          userId: input.userId,
          manifest: skillManifest,
          maxRootChars: skillRootChars(
            computeBudget({
              contextLength: model?.contextLength,
              webToolsEnabled: !!webTools,
            }).input,
            priorUsage,
          ),
        }).pipe(Effect.provideService(SkillReader, skillReader))
      : null;
    // A schedule's fire runs with nobody there: it may not ask questions,
    // and its schedule may leave telling the owner to the answer.
    const scheduleFire =
      fence && Option.isSome(database)
        ? yield* findScheduleFire(database.value, {
            messageId: input.messageId,
            generationId: fence.generationId,
          })
        : null;
    const askTools = scheduleFire ? null : prepareAskUserTool();
    // Replaced each turn, because a provider call id is unique only
    // within one and a handler only ever runs inside one.
    const turnCallRows = new Map<string, Deferred.Deferred<ToolCallRowRef | undefined>>();
    const callRowReady = (providerCallId: string) => {
      let ready = turnCallRows.get(providerCallId);
      if (!ready) {
        ready = Deferred.makeUnsafe<ToolCallRowRef | undefined>();
        turnCallRows.set(providerCallId, ready);
      }
      return ready;
    };
    // Machine tools wait for the page that sent the attempt to run them.
    const rowIdFor = (providerCallId: string) =>
      Effect.suspend(() => Deferred.await(callRowReady(providerCallId))).pipe(
        Effect.map((row) => row?.rowId),
      );
    // Offered once the person has connected a desktop app, from any device and machine online or
    // not, so the list is stable per person. Without the app nobody pays for these schemas.
    const desktopTools =
      permissions.work && (yield* deps.computerRepo.machines(input.userId)).length > 0
        ? prepareDesktopTools({ rowIdFor })
        : null;
    // Attempts from an app that can embed pages; they run in the sending app's own tabs.
    const browserTools =
      permissions.work && config.desktopBrowser ? prepareBrowserTools({ rowIdFor }) : null;
    // The checklist is an agent preference. Retry and edit start from a
    // clean list: a completed step is a claim about work this attempt did.
    // Resume continues that same work, so it keeps the last accepted list.
    const resumedPlan = ownCalls
      .filter((call) => call.toolName === "update_plan" && call.status === "complete")
      .map((call) => Schema.decodeUnknownOption(PlanSnapshot)(call.result))
      .findLast(Option.isSome);
    const planTools = config.planEnabled ? preparePlanTool(resumedPlan?.value ?? null) : undefined;
    const notifyTools =
      scheduleFire?.notify === "conditional" && fence && Option.isSome(database)
        ? prepareNotifyTool(database.value, {
            messageId: input.messageId,
            generationId: fence.generationId,
          })
        : null;
    // Real distances for any chat while maps are on; inside an answer what
    // it finds is also the answer's map lookups, so a block of the same
    // route draws at once and agrees with the prose.
    const mapRouteTools =
      maps.enabled && Option.isSome(mapLookups)
        ? prepareMapRouteTool({
            geocode: (query) => mapLookups.value.geocode(maps.services, query),
            route: (mode, stops) => mapLookups.value.route(maps.services, mode, stops),
            ...(mapResolver ? { seed: mapResolver.seed } : {}),
          })
        : null;
    // Admins switch Office file editing off in Tools; read per attempt so
    // it applies to the next answer.
    const officeFiles = yield* toolRegistry.getTool("office_files");
    const officeOffered = officeFiles.enabled && Option.isSome(database);
    const officeEditors = officeOffered ? runnableOfficeFamilies(processors) : [];
    // Admin-authored tools are resolved once as this generation starts,
    // then held stable for its remaining tool rounds. An edit or deletion
    // mid-flight changes nothing here. A module revises only its own drafts.
    // Files resolve once the attempt's resolver exists, below.
    const customTools = prepareCustomTools(
      customToolManifests,
      customToolRuntime,
      Option.isSome(database) ? (reference) => toolFiles!.resolve(reference) : undefined,
    );
    const offeredOwners = new Set<string>([
      ...officeEditors,
      ...[...(customTools?.tools.values() ?? [])].map((tool) => tool.owner),
    ]);
    // Drafts earlier answers left, for the editors this answer is offered.
    const kept = keptFiles
      ? (yield* keptFiles.list(input.conversationId)).filter((file) =>
          offeredOwners.has(file.owner),
        )
      : [];
    // After each round and when the answer ends however it ends: changed
    // drafts under the fence, so a crash loses at most one round and a
    // stopped, failed or questioning answer leaves them for the next one.
    // A superseded attempt is fenced out and saves nothing.
    const keepChanges = (workspace: WorkingFiles) =>
      fence && keptFiles
        ? Effect.forEach(
            workspace.changes(),
            (file) =>
              keptFiles.keep(fence, file).pipe(
                Effect.andThen(Effect.sync(() => workspace.markKept(file.ref))),
                Effect.catchTag("AttachmentRejected", (error) =>
                  Effect.logWarning(`working file ${file.name} not kept: ${english(error.reason)}`),
                ),
              ),
            { discard: true },
          ).pipe(Effect.exit, Effect.asVoid)
        : Effect.void;
    const workingFiles = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createWorkingFiles({
          kept,
          // A draft opened from a chat or project file is only as readable
          // as that file still is for the sender.
          load: async (file) => {
            if (
              file.source !== undefined &&
              !(await Effect.runPromise(toolFiles?.authorize(file.source) ?? Effect.succeed(false)))
            )
              throw new Error("The file this draft was opened from is no longer available.");
            if (!keptFiles) throw new Error("This working file is no longer available.");
            return Effect.runPromise(keptFiles.load(file));
          },
        }),
      ),
      (workspace) =>
        keepChanges(workspace).pipe(Effect.ensuring(Effect.sync(() => workspace.dispose()))),
    );
    const toolFiles = Option.isSome(database)
      ? makeToolFileResolver({
          db: database.value,
          store: promptDeps.store,
          projectFiles,
          userId: input.userId,
          conversationId: input.conversationId,
          projectId: config.resolvedProject?.id ?? null,
          workspace: workingFiles,
          ...(skillManifest.length
            ? { skills: { entries: skillManifest, reader: skillReader } }
            : {}),
        })
      : undefined;
    if (toolFiles)
      wordFiles = (reference) =>
        toolFiles.resolve(reference).pipe(
          Effect.flatMap((file) =>
            readWordDocument(
              file,
              Option.getOrNull(processors.word),
              input.userId,
              // Its pictures are the sender's uploads until the new document claims them.
              (image) =>
                Option.isSome(imageAttachments)
                  ? imageAttachments.value
                      .upload({
                        userId: input.userId,
                        fileName: image.name,
                        declaredMediaType: image.mediaType,
                        bytes: image.bytes,
                        allowedKinds: ["image"],
                      })
                      .pipe(
                        Effect.map((attachment) => attachment.id),
                        Effect.mapError(() => "unstored"),
                      )
                  : Effect.fail("unstored"),
            ),
          ),
        );
    let previewTurnFiles: Array<Prompt.UserMessagePartEncoded> = [];
    let previewCount = 0;
    let previewBytes = 0;
    // Fonts a loaded skill carries render in this answer's previews. Read
    // again only when the loaded set changes; a face that fails is skipped.
    let skillFaceSet: { key: string; faces: Promise<readonly FontFace[]> } | null = null;
    const skillFaces = (): Promise<readonly FontFace[]> => {
      if (!skillTools || Option.isNone(presentationFonts)) return Promise.resolve([]);
      const entries = skillTools.loadedSkills();
      const key = entries.map((entry) => entry.revisionId).join(",");
      if (skillFaceSet?.key !== key)
        skillFaceSet = {
          key,
          faces: Effect.runPromise(
            Effect.gen(function* () {
              const fonts: Array<{ sha256: string; bytes: Uint8Array }> = [];
              for (const entry of entries)
                for (const file of yield* skillReader.listFiles(input.userId, entry)) {
                  if (file.mediaType !== "font/ttf" && file.mediaType !== "font/otf") continue;
                  if (fonts.length >= SKILL_FONT_FACES) break;
                  const read = yield* skillReader.readPinnedBytes(input.userId, entry, file.path);
                  if (read) fonts.push({ sha256: sha256Hex(read.bytes), bytes: read.bytes });
                }
              return yield* presentationFonts.value.skillFaces(fonts);
            }).pipe(Effect.orElseSucceed(() => [])),
          ),
        };
      return skillFaceSet.faces;
    };
    const officeTools =
      officeEditors.length && toolFiles
        ? prepareOfficeTools(processors, {
            owner: input.userId,
            workingFiles,
            resolveFile: toolFiles.resolve,
            presentation: {
              // Loaded skills' fonts ride along with every job.
              faces: skillFaces,
              ...(Option.isSome(presentationFonts)
                ? {
                    fonts: async () => [
                      ...new Set([
                        ...(await Effect.runPromise(presentationFonts.value.families())),
                        ...(await skillFaces()).map((face) => face.family),
                      ]),
                    ],
                    ensureFonts: (families: readonly string[]) =>
                      Effect.runPromise(presentationFonts.value.ensure(families)),
                  }
                : {}),
              ...(model?.capabilities.vision
                ? {
                    onPreview: async (
                      slides: readonly { slideId: number; png: Uint8Array; label: string }[],
                    ) => {
                      const bytes = slides.reduce((total, slide) => total + slide.png.length, 0);
                      if (
                        previewCount + slides.length > PREVIEW_FEEDBACK_LIMITS.slides ||
                        previewBytes + bytes > PREVIEW_FEEDBACK_LIMITS.bytes
                      )
                        throw new Error("This attempt has exhausted its visual preview budget.");
                      const feedback = await Promise.all(
                        slides.map((slide) =>
                          Effect.runPromise(
                            fileForModel(promptDeps.parser, {
                              fileName: `${slide.label}.png`,
                              mediaType: "image/png",
                              bytes: slide.png,
                              vision: true,
                              files: model.capabilities.files ?? false,
                            }),
                          ),
                        ),
                      );
                      previewCount += slides.length;
                      previewBytes += bytes;
                      previewTurnFiles.push(...feedback);
                    },
                  }
                : {}),
            },
          })
        : [];
    // The Office family whose tools this answer offers under `name`.
    const offeredOffice = new Set(officeTools.map((tool) => tool.family));
    const officeFamilyOf = (name: string) => {
      const family = officeFamilyOfTool(name);
      return family && offeredOffice.has(family) ? { family, ...OFFICE_FAMILIES[family] } : null;
    };
    // Loaded once, before the toolkit, and held for every round: an admin
    // edit mid-answer applies to the next answer. Checked again here, so
    // a model that became unusable since resolution offers nothing.
    const imageModel =
      config.imageModel && fence && Option.isSome(imageAttachments)
        ? yield* loadImageModel(input.userId, config.imageModel.id).pipe(
            Effect.provideService(ProviderRepo, providers),
          )
        : null;
    // One budget for the answer's generated images, the model's own included.
    const imageBudget = makeImageBudget(
      ownFiles.filter((file) => isGeneratedImage(file.source)).length,
      ANSWER_FILE_LIMITS.images,
    );
    const imageTool = imageModel
      ? prepareImageTool({
          model: imageModel,
          resolveFile: toolFiles?.resolve,
          budget: imageBudget,
          rowIdFor,
          preview: (callId, image) =>
            Effect.gen(function* () {
              if (!fence) return;
              yield* sink.publishPreview(callId, image);
            }),
          record: (operation) =>
            analytics
              .record({
                userId: input.userId,
                kind: "image",
                modelId: imageModel.id,
                modelName: imageModel.name,
                conversationId: input.conversationId,
                messageId: input.messageId,
                status: operation.status,
                inputTokens: operation.usage.inputTokens,
                outputTokens: operation.usage.outputTokens,
                cachedInputTokens: 0,
                cacheWriteTokens: null,
                reasoningTokens: 0,
                usageComplete: operation.usage.complete,
                cost: operation.cost,
                costSource: operation.costSource,
                imageCount: operation.images,
                ...(operation.toolCallId ? { toolCallId: operation.toolCallId } : {}),
                ...(input.generationId ? { generationId: input.generationId } : {}),
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("image usage could not be recorded", cause),
                ),
              ),
        })
      : undefined;
    // Fixed for the answer, after history: another image model changes
    // this note, never the cached prefix ahead of it.
    const imageNotice: ReadonlyArray<Prompt.MessageEncoded> = imageModel
      ? [
          {
            role: "user",
            content: `<application-policy>\n${imageModelNote(
              imageModel,
              model?.capabilities.imageOutput === true,
            )}\n</application-policy>`,
          },
        ]
      : [];
    // Drafts exist only where an editor is offered, and so does delivery.
    // Machine tools return files too (screenshots, reads, imports), which
    // only publishing delivers.
    const fileDelivery = preparePublishFileTool(workingFiles);
    const publishFileTool =
      officeTools.length || customTools || desktopTools || browserTools ? fileDelivery : undefined;
    // Writing a text file needs no editor, only somewhere to deliver it.
    const createFileTool = fence && Option.isSome(imageAttachments) ? fileDelivery : undefined;
    // Fixed for the whole answer: it sits ahead of this answer's rounds,
    // so changing it between rounds would uncache every round after it.
    // Names are file data, so they are quoted rather than trusted as policy.
    const keptNotice: ReadonlyArray<Prompt.MessageEncoded> =
      kept.length && publishFileTool
        ? [
            {
              role: "user",
              content: `<application-policy>\nUnpublished working files kept from ${resuming ? "this answer before it was interrupted, or from earlier answers," : "earlier answers"} in this chat. Continue one by passing its reference to the tool that made it (a presentation, spreadsheet or Word tool takes it as workingRef, alone, never with sourceRef); publish_file delivers it. Each reference names the draft's latest saved revision.\n${kept
                .map((file) => `- ${formatFileRef(file.ref)} ${quotedName(file.name)}`)
                .join("\n")}\n</application-policy>`,
            },
          ]
        : [];
    const integrationTools = integrationOffer.length
      ? prepareIntegrationTools({
          offered: integrationOffer,
          indexer,
          approvals: integrationApprovals,
          owner: {
            userId: input.userId,
            conversationId: input.conversationId,
            messageId: input.messageId,
          },
          permissionsFor: (connectionId) =>
            integrations.permissionsFor(input.userId, input.conversationId, connectionId),
          sessionFor: (connectionId) =>
            integrations.session(input.userId, connectionId).pipe(Effect.orElseSucceed(() => null)),
          rowIdFor: (providerCallId) =>
            Effect.suspend(() => Deferred.await(callRowReady(providerCallId))).pipe(
              Effect.map((row) => row?.rowId),
            ),
          reportAuthFailure: (_session, failure) =>
            integrations.reportAuthFailure({
              userId: input.userId,
              failure,
            }),
          reportMissingScopes: (session, scopes) =>
            integrations.reportMissingScopes(
              {
                userId: input.userId,
                connectionId: session.connectionId,
                accountEpoch: session.accountEpoch,
              },
              scopes,
            ),
          allowanceUses: {
            reserve: (connectionId, allowance) =>
              integrations.reserveAllowance({
                messageId: input.messageId,
                connectionId,
                allowanceId: allowance.id,
                cap: allowance.cap,
              }),
            release: (connectionId, allowance) =>
              integrations.releaseAllowance({
                messageId: input.messageId,
                connectionId,
                allowanceId: allowance.id,
              }),
          },
        })
      : undefined;
    const knowledgeTools = knowledgeSession
      ? yield* prepareKnowledgeTools({
          userId: input.userId,
          session: knowledgeSession,
          indexer,
        }).pipe(Effect.provideService(KnowledgeService, knowledgeService))
      : null;

    // Read per attempt, so Keep takes effect on the next one. A chat
    // deleted underneath this attempt counts as temporary: fail closed.
    const chat = yield* repo.getConversation(input.userId, input.conversationId).pipe(
      Effect.map((row) => ({ temporary: row.temporary, projectId: row.projectId })),
      Effect.catchTag("ConversationNotFound", () =>
        Effect.succeed({ temporary: true, projectId: null }),
      ),
    );
    const { temporary } = chat;
    const conversationContext = yield* prepareConversationContext({
      memory,
      projectMemory,
      project: config.resolvedProject ?? null,
      userId: input.userId,
      conversationId: input.conversationId,
      history: completed,
      memoryDisabled: temporary,
      guard: writeGuard,
    });
    const { memoryTools } = conversationContext;
    // Offered in every kept chat, so the tool list stays the same turn to
    // turn; the person's other chats only while past chats are on.
    const historyTools = temporary
      ? null
      : prepareHistoryTools({
          repo,
          userId: input.userId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          otherChats: conversationContext.pastChats
            ? { excludeId: input.conversationId, projectId: chat.projectId }
            : null,
        });
    const memorySpent = ownCalls.some((call) => call.toolName === "save_memory");
    // Research is a tool on an ordinary turn: the model writes the brief
    // and answers from the evidence. The run it starts is owned by its
    // tool call and fenced by this generation.
    const researchTool =
      permissions.deepResearch &&
      permissions.webSearch &&
      config.researchEnabled &&
      repo.research &&
      fence &&
      (yield* researchAvailable(webSearch, urlReader))
        ? prepareResearchTool({
            store: repo.research,
            gateway,
            providers,
            webSearch,
            urlReader,
            userUrls: readerUrls,
            priorSources,
            config,
            knowledge: knowledgeSession
              ? { session: knowledgeSession, service: knowledgeService }
              : null,
            skillReader,
            userId: input.userId,
            conversationId: input.conversationId,
            messageId: input.messageId,
            generationId: fence.generationId,
            modelId: input.modelId,
            // A run spends on its own, so it is held to the limits an answer would be.
            admit: limits.check(input.userId, input.modelId).pipe(
              Effect.as(null),
              Effect.catchTag("UsageLimitReached", (error) =>
                Effect.succeed(english(error.reason)),
              ),
            ),
            rowFor: (providerCallId) =>
              Effect.suspend(() => Deferred.await(callRowReady(providerCallId))),
            emit: sink.pushTool,
            emitCompaction: sink.pushCompaction,
          })
        : null;
    // Offered by name only until loaded; see `tool-load.ts`. The set grows
    // through the answer and never shrinks within it.
    // A file too long to inline, or one summarized away, stays readable
    // by id; only files linked to this conversation's messages are.
    // Grows when a steer brings files in mid-answer.
    const conversationFiles = [
      ...(yield* promptDeps.attachments.listWithBlobsForMessages([
        ...completed.map((message) => message.id),
        ...ownSteers.map((steer) => steer.id),
      ])),
    ];
    const readable = (file: (typeof conversationFiles)[number]) =>
      ["text", "pdf"].includes(attachmentKind(file.mediaType)) || hasFileText(file.fileName);
    // What the rounds may change about the offer. The reader is always in
    // the toolkit, advertised only while a readable file is here (a project
    // chat always has one): a steered file can bring the first one in
    // mid-answer. Retrieval follows the knowledge context once decided.
    const offerState = {
      readerAdvertised: conversationFiles.some(readable) || projectFileTools !== null,
      retrievalEnabled: config.knowledgeMode === "retrieval",
    };
    const attachmentReader = prepareAttachmentReader({
      deps: promptDeps,
      owner: input.userId,
      project: projectFileTools && toolFiles ? toolFiles.resolve : undefined,
      find: (requested) =>
        Effect.gen(function* () {
          // A branch maps its source's ids onto its own copies, as in a
          // summary's file list; the alias grants nothing by itself.
          const attachmentId = Option.isSome(database)
            ? yield* currentAttachmentId(database.value, input, requested)
            : requested;
          return conversationFiles.find((file) => file.id === attachmentId) ?? null;
        }),
    });
    // The system prompt's catalogue, in this order: the fixed families, then each
    // integration whose tools are too long to offer before they are needed.
    const lazyCatalog: ReadonlyArray<{ family: LoadableToolFamily; summary: string }> = [
      ...LazyToolFamily.literals
        .filter((family) =>
          family === "agent-draft"
            ? permissions.agentsCreate
            : family === "schedule-draft"
              ? permissions.schedules
              : family === "browser"
                ? browserTools !== null
                : offeredOffice.has(family),
        )
        .map((family) => ({ family, summary: fixedFamilySummary(family) })),
      ...(integrationTools?.lazy ?? []),
    ];
    const offeredLazy = lazyCatalog.map((entry) => entry.family);
    const unlockedFamilies = new Set<LoadableToolFamily>();
    const unlockFamily = (family: LoadableToolFamily | null | undefined) => {
      if (family && offeredLazy.includes(family)) unlockedFamilies.add(family);
    };
    const unlockTool = (name: string) => unlockFamily(lazyFamilyOfTool(name));
    const toolLoad = offeredLazy.length
      ? prepareToolLoad({ offered: offeredLazy, unlocked: unlockedFamilies })
      : undefined;
    // A stored call that shows a family was in use: an explicit load, a
    // call to one of its tools, or the authoring skill that drives it.
    const unlockByCall = (
      into: Set<LoadableToolFamily>,
      call: { toolName: string; result: unknown },
    ) => {
      const add = (name: string) => {
        const family = lazyFamilyOfTool(name);
        if (family && offeredLazy.includes(family)) into.add(family);
      };
      if (call.toolName === "load_tools") {
        const loaded = Schema.decodeUnknownOption(LoadToolsResult)(call.result);
        if (Option.isSome(loaded))
          for (const family of loaded.value.loaded)
            if (offeredLazy.includes(family)) into.add(family);
      } else if (call.toolName === "load_skill") {
        const family = findBuiltinSkill((call.result as { skillId?: unknown } | null)?.skillId)
          ?.unlocks?.family;
        if (family && offeredLazy.includes(family)) into.add(family);
      } else add(call.toolName);
    };
    const commonGroups = [
      ...(toolLoad ? [toolLoad] : []),
      attachmentReader.group,
      ...(historyTools ? [historyTools] : []),
      ...(permissions.agentsCreate ? [authoring.group] : []),
      ...(permissions.schedules ? [scheduleAuthoring.group] : []),
      ...(permissions.documents ? [documents.group] : []),
      ...(projectFileTools ? [projectFileTools.group] : []),
      ...(researchTool ? [researchTool.group] : []),
      ...(desktopTools ? [desktopTools] : []),
      ...(browserTools ? [browserTools] : []),
      ...(skillTools ? [skillTools.group] : []),
      ...(webTools ? [webTools.group] : []),
      ...(planTools ? [planTools.group] : []),
      ...(notifyTools ? [notifyTools.group] : []),
      ...(mapRouteTools ? [mapRouteTools] : []),
      ...officeTools.map((tool) => tool.group),
      ...(customTools ? [customTools.group] : []),
      ...(imageTool ? [imageTool.group] : []),
      ...(publishFileTool ? [publishFileTool.group] : []),
      ...(createFileTool ? [createFileTool.createGroup] : []),
      ...(integrationTools ? [integrationTools.group] : []),
      ...(askTools ? [askTools] : []),
    ];
    // Reserve retrieval schemas before preparation: a context selection
    // may downgrade once rendered. Execution tools are built afterwards.
    const budgetToolkit = yield* mergeToolGroups([
      ...commonGroups,
      ...(knowledgeTools ? [knowledgeTools.group] : []),
      ...(memoryTools ? [memoryTools.group] : []),
    ]);
    // Only advertised schemas cost input. Before the retained history is
    // known, reserve for every family anything in this chat has used.
    const schemaTokensWith = (unlocked: ReadonlySet<LoadableToolFamily>) =>
      budgetToolkit &&
      estimateToolSchemaTokens({
        tools: Object.fromEntries(
          Object.entries(budgetToolkit.tools).filter(
            ([name]) =>
              isAdvertised(name, offeredLazy, unlocked) &&
              (offerState.readerAdvertised || name !== "read_attachment"),
          ),
        ),
      });
    const everUnlocked = new Set<LoadableToolFamily>();
    for (const call of priorToolCalls)
      if (call.researchRunId === null) unlockByCall(everUnlocked, call);
    for (const file of kept) if (isOfficeFamily(file.owner)) everUnlocked.add(file.owner);
    const toolSchemaTokens = schemaTokensWith(everUnlocked) ?? 0;
    const summaryToolChoice = (
      toolkit: { tools: Record<string, unknown> },
      unlocked: ReadonlySet<LoadableToolFamily>,
    ) => {
      const names = Object.keys(toolkit.tools).filter(
        (name) =>
          isAdvertised(name, offeredLazy, unlocked) &&
          (offerState.readerAdvertised || name !== "read_attachment") &&
          (offerState.retrievalEnabled || !Schema.is(KnowledgeToolName)(name)) &&
          !(memorySpent && name === "save_memory"),
      );
      return names.length < Object.keys(toolkit.tools).length
        ? { oneOf: names }
        : ("auto" as const);
    };
    // The family each offered tool's group declared. A name outside the
    // offer gets no row: the toolkit runs no handler for it. Retrieval is
    // decided before the first call, and a spent memory save is not offered.
    const offeredFamilies = toolFamilies([
      ...commonGroups,
      ...(memoryTools && !memorySpent ? [memoryTools.group] : []),
    ]);
    const knowledgeFamilies = toolFamilies(knowledgeTools ? [knowledgeTools.group] : []);
    const familyOf = (name: string): ToolFamily | null =>
      offeredFamilies.get(name) ??
      (offerState.retrievalEnabled ? knowledgeFamilies.get(name) : undefined) ??
      null;
    // What retained history already worked with stays loaded: an explicit
    // load, a lazy tool it called, an authoring skill it loaded, a kept
    // draft or an attached Office file. Decided once, so a later hard
    // truncation in this answer never takes a family away mid-answer.
    const unlockRetained = (retained: ReadonlySet<string>) =>
      Effect.gen(function* () {
        if (offeredLazy.length) {
          for (const call of priorToolCalls)
            if (
              call.researchRunId === null &&
              (retained.has(call.messageId) || call.messageId === input.messageId)
            )
              unlockByCall(unlockedFamilies, call);
          for (const file of kept)
            if (isOfficeFamily(file.owner)) unlockTool(OFFICE_FAMILIES[file.owner].edit);
          const files = yield* promptDeps.attachments.listWithBlobsForMessages([
            ...retained,
            ...ownSteers.map((steer) => steer.id),
          ]);
          for (const file of files) {
            const family = officeFamilyOfFile({ name: file.fileName, mediaType: file.mediaType });
            if (family) unlockTool(OFFICE_FAMILIES[family].edit);
          }
        }
      });
    const executionToolkits = Effect.gen(function* () {
      const executionGroups = [
        ...commonGroups,
        ...(offerState.retrievalEnabled && knowledgeTools ? [knowledgeTools.group] : []),
      ];
      const nonMemoryToolkit = yield* mergeToolGroups(executionGroups);
      const toolkit = memoryTools
        ? yield* mergeToolGroups([...executionGroups, memoryTools.group])
        : nonMemoryToolkit;
      return { nonMemoryToolkit, toolkit };
    });
    return {
      authoring,
      scheduleAuthoring,
      documents,
      authority,
      indexer,
      webTools,
      interactiveUi,
      imageResolver,
      mapResolver,
      knowledgeSession,
      skillManifest,
      skillTools,
      callRowReady,
      desktopTools,
      browserTools,
      planTools,
      notifyTools,
      mapRouteTools,
      officeEditors,
      kept,
      keepChanges,
      workingFiles,
      toolFiles,
      attachmentReader,
      officeFamilyOf,
      customTools,
      imageModel,
      imageBudget,
      imageTool,
      imageNotice,
      fileDelivery,
      publishFileTool,
      createFileTool,
      keptNotice,
      integrationTools,
      knowledgeTools,
      temporary,
      historyTools,
      conversationContext,
      memoryTools,
      memorySpent,
      researchTool,
      conversationFiles,
      readable,
      offerState,
      offeredLazy,
      lazyCatalog,
      unlockedFamilies,
      unlockTool,
      unlockFamily,
      unlockByCall,
      budgetToolkit,
      schemaTokensWith,
      toolSchemaTokens,
      summaryToolChoice,
      familyOf,
      unlockRetained,
      executionToolkits,
      /** Where a vision model's slide previews go: the round being run. */
      setPreviewTarget: (files: Array<Prompt.UserMessagePartEncoded>) => {
        previewTurnFiles = files;
      },
      /** Provider call ids are unique only within one turn. */
      clearCallRows: () => turnCallRows.clear(),
    };
  });

export type GenerationTools = Effect.Success<ReturnType<typeof prepareGenerationTools>>;
