import { requireEligibleAccount } from "~/modules/auth/server/account-eligibility.ts";
import type { DesktopSubmission } from "../schema.ts";
import { Effect, Option } from "effect";
import { sendsReasoningEffort } from "~/modules/providers/provider-presets.ts";
import { InvalidMessage, ModelNotFound, WorkDesktopRequired } from "~/modules/chat/errors.ts";
import { UsageLimits } from "~/modules/limits/server/service.ts";
import { attachmentKind, MAX_ATTACHMENTS_PER_MESSAGE } from "~/modules/attachments/constants.ts";
import { AttachmentNotAvailable, AttachmentUnsupported } from "~/modules/attachments/errors.ts";
import { DocumentParser } from "~/modules/attachments/server/document-parser.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import type { ReasoningEffort } from "~/modules/providers/model-config.ts";
import { UrlReaderExecutor } from "~/modules/tools/server/url-reader.ts";
import { ToolUnavailable, WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import { AgentNotAvailable } from "~/modules/agents/errors.ts";
import { resolveProject } from "~/modules/projects/server/access.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { resolveImageModel } from "~/modules/images/server/resolve.ts";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import {
  resolveAgentSelection,
  resolveEffectiveGeneration,
  resolveAttemptSkills,
} from "./effective-config.ts";
import type { ConversationDefaults, ResolveGeneration } from "./repo.ts";
import type { IntegrationGrant } from "~/modules/integrations/grant.ts";

/**
 * One folder the sending machine named, by its real path. The path is the
 * model's address for everything inside; it flows through attempt-scoped
 * prompt text and tool traffic only, and is never written to a row.
 */
export type DesktopFolderRef = DesktopSubmission["desktopFolders"] extends
  | ReadonlyArray<infer F>
  | undefined
  ? F
  : never;

/**
 * What every attempt is checked against before anything is written, and the
 * resolver that settles its configuration inside the attempt's transaction.
 */
export const makeAttemptOptions = Effect.gen(function* () {
  const providers = yield* ProviderRepo;
  const webSearch = yield* WebSearchExecutor;
  const urlReaderOption = yield* Effect.serviceOption(UrlReaderExecutor);
  const policy = yield* FeaturePolicy;
  const limits = yield* UsageLimits;
  const attachmentRepo = yield* AttachmentRepo;
  const agents = yield* AgentRepo;
  const knowledge = yield* KnowledgeRepo;
  const documentParser = yield* DocumentParser;

  // The composer's toggle gates web_search only; read_url is gated by user URLs.
  const searchToolEnabled = Effect.gen(function* () {
    const search = yield* webSearch.availability();
    return search.configured && search.enabled;
  });

  const supportsReasoningEffort = Effect.fn("ChatService.supportsReasoningEffort")(function* (
    model: {
      providerId: string;
      modelKey: string;
      capabilities: { reasoningEfforts?: ReadonlyArray<ReasoningEffort> };
    },
    effort: ReasoningEffort,
  ) {
    if (!model.capabilities.reasoningEfforts?.includes(effort)) return false;
    const provider = (yield* providers.listProviders()).find((row) => row.id === model.providerId);
    return !!provider && sendsReasoningEffort(provider, model.modelKey);
  });

  const validateGenerationOptions = Effect.fn("ChatService.validateGenerationOptions")(
    function* (input: {
      userId: string;
      modelId: string;
      searchEnabled: boolean;
      attachmentIds: ReadonlyArray<string>;
      researchEnabled?: boolean | undefined;
      reasoningEffort?: ReasoningEffort | null | undefined;
    }) {
      if (input.attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        return yield* new InvalidMessage({
          reason: `at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`,
        });
      }

      const model = yield* providers.getModel(input.modelId);
      if (!model || !model.enabled || model.type !== "chat") {
        return yield* new ModelNotFound({ modelId: input.modelId });
      }
      // Group-restricted models answer exactly like nonexistent ones, so a
      // denied id discloses nothing.
      if (!(yield* providers.isModelAccessible(input.userId, input.modelId))) {
        return yield* new ModelNotFound({ modelId: input.modelId });
      }
      if (
        input.reasoningEffort != null &&
        !(yield* supportsReasoningEffort(model, input.reasoningEffort))
      )
        return yield* new InvalidMessage({
          reason: "This model does not support the selected reasoning effort.",
        });

      if (input.searchEnabled && !(yield* policy.can(input.userId, "webSearch")))
        return yield* new ToolUnavailable({ tool: "web_search", reason: "not permitted" });
      if (input.researchEnabled && !(yield* policy.can(input.userId, "deepResearch")))
        return yield* new ToolUnavailable({ tool: "deep_research", reason: "not permitted" });
      if (input.researchEnabled && !(yield* policy.can(input.userId, "webSearch")))
        return yield* new ToolUnavailable({
          tool: "deep_research",
          reason: "web search is not permitted",
        });
      if (input.attachmentIds.length && !(yield* policy.can(input.userId, "attachments")))
        return yield* new AttachmentNotAvailable({ attachmentId: input.attachmentIds[0]! });

      // The research toggle only offers the tool, so an instance without
      // search or a reader degrades to not offering it. Refusing the whole
      // message would make an unrelated admin setting reject ordinary chat.
      const reader =
        input.researchEnabled && Option.isSome(urlReaderOption)
          ? yield* urlReaderOption.value.availability()
          : null;
      const researchEnabled =
        !!input.researchEnabled &&
        !!reader?.configured &&
        reader.enabled &&
        (yield* searchToolEnabled);
      if (input.searchEnabled && !(yield* searchToolEnabled)) {
        return yield* new ToolUnavailable({ tool: "web_search", reason: "not enabled" });
      }

      const attachmentFileNames = yield* validateAttachments(
        input.userId,
        model.capabilities,
        input.attachmentIds,
      );

      return { model, attachmentFileNames, researchEnabled };
    },
  );

  // Rejects attachments the model cannot read before anything is written, so
  // the user gets a 400 instead of a generation that fails halfway through.
  // Returns their file names in the caller's order, since the title generator
  // needs them and the rows are already loaded here.
  const validateAttachments = Effect.fn("ChatService.validateAttachments")(function* (
    userId: string,
    capabilities: { vision: boolean; files: boolean },
    attachmentIds: ReadonlyArray<string>,
  ) {
    if (attachmentIds.length === 0) return [] as ReadonlyArray<string>;

    const rows = yield* attachmentRepo.listWithBlobsByIds(userId, attachmentIds);
    const byId = new Map(rows.map((row) => [row.id, row]));
    // Parsing availability is only consulted once, and only if a PDF meets a
    // model that cannot read files natively.
    let parsing: { configured: boolean; enabled: boolean } | null = null;
    const fileNames: string[] = [];

    for (const attachmentId of attachmentIds) {
      const row = byId.get(attachmentId);
      if (!row) return yield* new AttachmentNotAvailable({ attachmentId });

      fileNames.push(row.fileName);

      const kind = attachmentKind(row.mediaType);
      if (kind === "image" && !capabilities.vision) {
        return yield* new AttachmentUnsupported({
          fileName: row.fileName,
          reason: "this model cannot read images",
        });
      }
      if (kind === "pdf" && !capabilities.files) {
        parsing ??= yield* documentParser.availability();
        if (!parsing.configured || !parsing.enabled) {
          return yield* new AttachmentUnsupported({
            fileName: row.fileName,
            reason:
              "this model cannot read PDFs and document parsing is disabled. Enable it in admin settings or pick a model that accepts files",
          });
        }
      }
    }

    return fileNames;
  });

  // Sends a user message (creates the conversation on first message).
  // Returns ids the client needs to subscribe to the assistant stream.
  // Effective configuration resolves inside the turn's transaction against
  // conversation defaults, so what is stored is what was read; access
  // failures fail the turn before any row is written.
  const resolver =
    (
      input: {
        userId: string;
        model: {
          id: string;
          providerId: string;
          modelKey: string;
          contextLength: number | null | undefined;
          capabilities: { reasoningEfforts?: ReadonlyArray<ReasoningEffort> };
        };
        searchAvailable: boolean;
        collectionIds?: ReadonlyArray<string> | undefined;
        skillIds?: ReadonlyArray<string> | undefined;
        /** Folders the sending machine reported; retry has no submission. */
        desktopFolders?: ReadonlyArray<DesktopFolderRef> | undefined;
        desktopCommands?: boolean | undefined;
        desktopBrowser?: boolean | undefined;
        fromDesktop?: boolean | undefined;
        desktopExecutorId?: string | undefined;
        /** Which machine this attempt is sent from; a retry re-stamps it. */
        desktopMachineId?: string | undefined;
        desktopMachineName?: string | undefined;
        /** Files this send copied into the workspace; only a send carries them. */
        workspaceFiles?: ReadonlyArray<string> | undefined;
        /** A queued choice was valid when submitted, but policy may have changed. */
        allowStaleReasoningEffort?: boolean;
        /**
         * A schedule fire's up-front consent. Every other attempt, a retry of
         * a fired answer included, has a person present and passes none.
         */
        integrationGrants?: ReadonlyArray<IntegrationGrant>;
        /** The image model this submission picked; absent keeps the chat's own. */
        imageModelId?: string | null | undefined;
        /** Continues the same answer, so it keeps the image model it drew with. */
        resume?: boolean;
      } & (
        | {
            attempt: "retry";
            searchEnabled?: never;
            researchEnabled?: never;
            reasoningEffort?: never;
          }
        | {
            attempt: "send" | "edit";
            searchEnabled: boolean;
            researchEnabled: boolean;
            reasoningEffort?: ReasoningEffort | null | undefined;
          }
      ),
    ): ResolveGeneration =>
    (tx, defaults: ConversationDefaults, continuation) =>
      Effect.gen(function* () {
        yield* requireEligibleAccount(tx, input.userId);
        // Counts settled answers only, so one still running counts once it settles and two
        // sends at once may both pass. Nothing is ever stopped halfway.
        yield* limits.check(input.userId, input.model.id, tx);
        const imageModel = yield* resolveImageModel(tx, {
          userId: input.userId,
          conversationId: defaults.conversationId,
          lockId: defaults.imageModelId,
          explicitId: input.imageModelId,
          agentId: defaults.agent?.agentId,
          ...(input.resume ? { resumedId: continuation?.imageModel?.id ?? null } : {}),
        });
        // Read here like an agent, so retry and edit meet the project as it is
        // now, and a person who lost access cannot keep working in it.
        const resolvedProject = defaults.projectId
          ? yield* resolveProject(tx, input.userId, defaults.projectId).pipe(
              Effect.catchTag("ProjectNotAvailable", () =>
                Effect.fail(
                  new InvalidMessage({
                    reason:
                      "This chat’s project is no longer available to you. Remove the chat from the project to continue.",
                  }),
                ),
              ),
            )
          : null;
        const allowedSearch = yield* policy.can(input.userId, "webSearch", tx);
        const allowedResearch = yield* policy.can(input.userId, "deepResearch", tx);
        const searchEnabled =
          input.attempt === "retry"
            ? continuation
              ? continuation.searchEnabled && input.searchAvailable
              : yield* Effect.die("Retry requires a saved generation configuration")
            : input.attempt === "edit"
              ? input.searchEnabled && input.searchAvailable
              : (continuation?.searchEnabled ?? input.searchEnabled);
        // Same three cases as search. The third matters most here: the tool
        // cannot ask anything itself, so a clarification round would
        // otherwise answer into a turn that can no longer research.
        const researchEnabled =
          input.attempt === "retry"
            ? (continuation?.researchEnabled ?? false)
            : input.attempt === "edit"
              ? input.researchEnabled
              : (continuation?.researchEnabled ?? input.researchEnabled);
        const savedEffort = continuation?.reasoningEffort ?? null;
        const submittedEffort = input.attempt === "retry" ? undefined : input.reasoningEffort;
        const chosenEffort = submittedEffort !== undefined ? submittedEffort : savedEffort;
        const supportedEffort =
          chosenEffort === null || (yield* supportsReasoningEffort(input.model, chosenEffort));
        if (!supportedEffort && submittedEffort != null && !input.allowStaleReasoningEffort)
          return yield* new InvalidMessage({
            reason: "This model does not support the selected reasoning effort.",
          });
        const reasoningEffort = supportedEffort ? chosenEffort : null;
        if (searchEnabled && !allowedSearch)
          return yield* new InvalidMessage({ reason: "web search is not permitted" });
        if (researchEnabled && (!allowedResearch || !allowedSearch))
          return yield* new InvalidMessage({ reason: "deep research is not permitted" });
        if (defaults.mode === "work" && !(yield* policy.can(input.userId, "work", tx)))
          return yield* new InvalidMessage({ reason: "Work is not permitted" });
        if ((input.workspaceFiles?.length ?? 0) > 0 && defaults.mode !== "work")
          return yield* new InvalidMessage({ reason: "workspace files require Work" });
        const desktopFolderEntries =
          defaults.mode === "work" && input.desktopFolders && input.desktopFolders.length > 0
            ? input.desktopFolders
            : null;
        // What the sending app could do, kept for Work alone: these flags are
        // the one place the stream learns whether a machine tool is offered.
        const desktopCommands = defaults.mode === "work" && !!input.desktopCommands;
        const desktopBrowser = defaults.mode === "work" && !!input.desktopBrowser;
        if (defaults.mode === "work" && (!input.fromDesktop || !input.desktopExecutorId))
          return yield* new WorkDesktopRequired();
        // Re-stamped on every attempt, retry included: the banner must
        // name the machine the chat actually last worked on.
        const desktopMachineId = defaults.mode === "work" ? (input.desktopMachineId ?? null) : null;
        const desktopMachineName =
          defaults.mode === "work" ? (input.desktopMachineName ?? null) : null;
        // An edit that submits a selection is changing it, so it cannot take the
        // replay shortcut below: new collections need a rebuilt manifest.
        const editing = input.attempt === "edit";
        const editedCollections = editing ? input.collectionIds : undefined;
        const editedSkills = editing ? input.skillIds : undefined;
        if (!defaults.agent && continuation && editedCollections === undefined) {
          yield* knowledge.authorizeManifest(
            input.userId,
            continuation.collectionIds,
            continuation.manifest,
            tx,
          );
          return {
            ...continuation,
            // Plain knowledge retains its old manifest semantics; skills deliberately do not.
            skills: yield* resolveAttemptSkills(
              tx,
              input.userId,
              editedSkills ?? continuation.standaloneSkillIds ?? [],
              [],
            ),
            searchEnabled,
            researchEnabled,
            reasoningEffort,
            desktopFolders: desktopFolderEntries?.map((folder) => folder.name) ?? null,
            desktopCommands,
            desktopBrowser,
            desktopMachineId,
            desktopMachineName,
            // Only a fresh send adds files; retry and edit replay the list.
            workspaceFiles: input.workspaceFiles ?? continuation.workspaceFiles ?? [],
            integrationGrants: input.integrationGrants ?? null,
            resolvedProject,
            imageModel,
          };
        }
        const agent = defaults.agent
          ? defaults.agent.agentId
            ? yield* resolveAgentSelection({
                tx,
                userId: input.userId,
                agentId: defaults.agent.agentId,
              })
            : yield* new AgentNotAvailable({ agentId: "deleted" })
          : null;
        const resolved = yield* resolveEffectiveGeneration({
          tx,
          userId: input.userId,
          agent,
          // Omitted still keeps the saved selection; only a submitted one wins.
          collectionIds: editing
            ? (editedCollections ?? continuation?.standaloneCollectionIds)
            : (continuation?.standaloneCollectionIds ?? input.collectionIds),
          skillIds: editing
            ? (editedSkills ?? continuation?.standaloneSkillIds)
            : (continuation?.standaloneSkillIds ?? input.skillIds),
          searchEnabled,
          researchEnabled,
          reasoningEffort,
          desktopFolders: desktopFolderEntries,
          desktopCommands,
          desktopBrowser,
          desktopMachineId,
          desktopMachineName,
          workspaceFiles: input.workspaceFiles ?? continuation?.workspaceFiles ?? [],
          model: input.model,
          searchAvailable: input.searchAvailable,
        });
        return {
          ...resolved,
          integrationGrants: input.integrationGrants ?? null,
          resolvedProject,
          imageModel,
        };
      }).pipe(
        Effect.provideService(KnowledgeRepo, knowledge),
        Effect.provideService(AgentRepo, agents),
        Effect.provideService(ProviderRepo, providers),
      );

  return { searchToolEnabled, validateGenerationOptions, validateAttachments, resolver };
});

export type AttemptOptions = Effect.Success<typeof makeAttemptOptions>;
