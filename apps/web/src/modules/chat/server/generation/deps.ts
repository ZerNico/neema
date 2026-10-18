import { AgentDraftService } from "~/modules/agents/server/draft-service.ts";
import { DocumentService } from "~/modules/documents/server/document-service.ts";
import { ProjectFileService } from "~/modules/projects/server/project-files.ts";
import { ProjectMemoryService } from "~/modules/projects/server/project-memory.ts";

import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { ScheduleDraftService } from "~/modules/schedules/server/draft-service.ts";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { SkillRepo } from "~/modules/skills/server/repo.ts";
import { SkillReader } from "~/modules/skills/server/reader.ts";
import { PresentationFonts } from "~/modules/presentations/server/fonts.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import { officeProcessors } from "~/modules/office/server/families.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { fetchImage, ImageFetcher } from "~/modules/genui/server/image-fetcher.ts";
import { MapLookups } from "~/modules/genui/server/map-lookups.ts";
import { Effect, Option } from "effect";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { Db } from "~/server/db.ts";
import { KeptWorkingFiles } from "../kept-working-files.ts";
import { DocumentParser } from "~/modules/attachments/server/document-parser.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AiGateway } from "~/modules/providers/server/gateway.ts";
import { MemoryService } from "~/modules/memory/server/service.ts";
import { KnowledgeSearch } from "~/modules/knowledge/server/search.ts";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { IntegrationApprovals } from "~/modules/integrations/server/approvals.ts";
import { IntegrationService } from "~/modules/integrations/server/service.ts";
import { CustomToolRepo } from "~/modules/custom-tools/server/repo.ts";
import { CustomToolRuntime } from "~/modules/custom-tools/server/runtime.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";

import { UrlReaderExecutor } from "~/modules/tools/server/url-reader.ts";
import { WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import { ExternalCompletion } from "~/modules/tools/server/external-completion.ts";
import { type PromptDeps } from "../prompt.ts";
import { ChatRepo } from "../repo.ts";

/**
 * The services every attempt uses, read once as the engine is built. Optional
 * ones stay options, so test engines need not provide them.
 */
export const generationDeps = Effect.gen(function* () {
  const repo = yield* ChatRepo;
  const external = yield* ExternalCompletion;
  const gateway = yield* AiGateway;
  const sync = yield* SyncBus;
  const webSearch = yield* WebSearchExecutor;
  const urlReader = yield* UrlReaderExecutor;
  const providers = yield* ProviderRepo;
  const authoringServices = {
    agents: yield* AgentRepo,
    providers,
    drafts: yield* AgentDraftService,
    skills: yield* SkillRepo,
    knowledge: yield* KnowledgeRepo,
  };
  const scheduleAuthoringServices = {
    providers,
    drafts: yield* ScheduleDraftService,
  };
  const documentService = yield* DocumentService;
  const analytics = yield* AnalyticsRepo;
  const memory = yield* MemoryService;
  const projectMemory = yield* ProjectMemoryService;
  const knowledgeSearch = yield* KnowledgeSearch;
  const knowledgeService = yield* KnowledgeService;
  const skillReader = yield* SkillReader;
  const customToolRuntime = yield* CustomToolRuntime;
  const customToolRepo = yield* CustomToolRepo;
  const processors = yield* officeProcessors;
  const presentationFonts = yield* Effect.serviceOption(PresentationFonts);
  const toolRegistry = yield* Effect.serviceOption(ToolsRepo);
  const policy = yield* FeaturePolicy;
  const integrations = yield* IntegrationService;
  const integrationApprovals = yield* IntegrationApprovals;
  const attachments = yield* AttachmentRepo;
  const basePromptDeps: PromptDeps = {
    attachments,
    store: yield* BlobStore,
    parser: yield* DocumentParser,
  };
  const imageAttachments = yield* Effect.serviceOption(AttachmentService);
  // Optional so test engines need not reach map services.
  const mapLookups = yield* Effect.serviceOption(MapLookups);
  // Tests replace the network; everything else fetches search images itself.
  const imageFetcher = Option.getOrElse(yield* Effect.serviceOption(ImageFetcher), () =>
    ImageFetcher.of({ fetch: fetchImage }),
  );
  // Optional so test engines need not build blob storage for it.
  const projectFiles = yield* Effect.serviceOption(ProjectFileService);
  // Optional for the same reason; without it a tool's file parameter
  // simply finds no files.
  const database = yield* Effect.serviceOption(Db);
  // Unpublished working files outlive their answer only where storage
  // exists; test engines without it keep none.
  const keptFiles = Option.getOrUndefined(yield* Effect.serviceOption(KeptWorkingFiles));
  return {
    repo,
    external,
    gateway,
    sync,
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
    customToolRepo,
    processors,
    presentationFonts,
    toolRegistry,
    policy,
    integrations,
    integrationApprovals,
    attachments,
    imageAttachments,
    mapLookups,
    imageFetcher,
    projectFiles,
    database,
    keptFiles,
    basePromptDeps,
  };
});

export type GenerationDeps = Effect.Success<typeof generationDeps>;
