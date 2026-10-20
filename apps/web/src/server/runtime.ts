import { Layer, ManagedRuntime } from "effect";
import { MapLookups } from "~/modules/genui/server/map-lookups.ts";
import { AgentDraftService } from "~/modules/agents/server/draft-service.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { AgentService } from "~/modules/agents/server/service.ts";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { DocumentParser } from "~/modules/attachments/server/document-parser.ts";
import { fsBlobStoreLayer } from "~/modules/attachments/server/fs-blob-store.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { OAuthRepo } from "~/modules/auth/server/oauth-repo.ts";
import { SignupRepo } from "~/modules/auth/server/signup-repo.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { ChatService } from "~/modules/chat/server/service.ts";
import { StreamEngine } from "~/modules/chat/server/streaming.ts";
import { CustomToolBuilder } from "~/modules/custom-tools/server/builder.ts";
import { CustomToolInstaller } from "~/modules/custom-tools/server/installer.ts";
import { CustomToolRepo } from "~/modules/custom-tools/server/repo.ts";
import { CustomToolRuntime } from "~/modules/custom-tools/server/runtime.ts";
import { GroupRepo } from "~/modules/groups/server/repo.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { UsageLimits } from "~/modules/limits/server/service.ts";
import { IntegrationApprovals } from "~/modules/integrations/server/approvals.ts";
import { ToolListingSweep } from "~/modules/integrations/server/tool-listing-sweep.ts";
import { IntegrationRepo } from "~/modules/integrations/server/repo.ts";
import { IntegrationService } from "~/modules/integrations/server/service.ts";
import { KnowledgeSourceService } from "~/modules/integrations/server/sync.ts";
import { EmbeddingSpace } from "~/modules/knowledge/server/embedding-space.ts";
import { KnowledgeIndexer } from "~/modules/knowledge/server/indexer.ts";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import { KnowledgeSearch } from "~/modules/knowledge/server/search.ts";
import { MemoryRepo } from "~/modules/memory/server/repo.ts";
import { MemoryService } from "~/modules/memory/server/service.ts";
import { SidebarPinsService } from "~/modules/navigation/server/service.ts";
import { AiGateway } from "~/modules/providers/server/gateway.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { ProjectFileService } from "~/modules/projects/server/project-files.ts";
import { KeptWorkingFiles } from "~/modules/chat/server/kept-working-files.ts";
import { PresentationFonts } from "~/modules/presentations/server/fonts.ts";
import { PresentationProcessor } from "~/modules/presentations/server/processor.ts";
import { SpreadsheetProcessor } from "~/modules/spreadsheets/server/runtime.ts";
import { WordProcessor } from "~/modules/word/server/runtime.ts";
import { ProjectService } from "~/modules/projects/server/service.ts";
import { SharingService } from "~/modules/sharing/server/service.ts";
import { SkillRepo } from "~/modules/skills/server/repo.ts";
import { SkillService } from "~/modules/skills/server/service.ts";
import { DraftService } from "~/modules/drafts/server/service.ts";
import { ScheduleFire } from "~/modules/schedules/server/fire.ts";
import { ScheduleRepo } from "~/modules/schedules/server/repo.ts";
import { ApiKeys } from "~/modules/api-keys/server/service.ts";
import { ConnectedApps } from "~/modules/mcp-server/server/connected-apps.ts";
import { ScheduleService } from "~/modules/schedules/server/service.ts";
import { ScheduleSettlement } from "~/modules/schedules/server/settle.ts";
import { NotificationService } from "~/modules/notifications/server/service.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { PageExtractor } from "~/modules/tools/server/extraction.ts";
import { ExternalCompletion } from "~/modules/tools/server/external-completion.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import { SearchProviders } from "~/modules/tools/server/search-providers/chain.ts";
import { SearchProviderRepo } from "~/modules/tools/server/search-provider-repo.ts";
import { UrlReaderExecutor } from "~/modules/tools/server/url-reader.ts";
import { WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import { Db, PgLive } from "./db.ts";

// Application layer graph. Server functions and routes run effects against
// this shared runtime; its resources (pg pool, pubsub relays, in-flight
// generation fibers) live until the next dev reload replaces it, or for the
// process lifetime in production.
const InfraLayer = Layer.mergeAll(Db.layer, KeyCipher.layer, fsBlobStoreLayer).pipe(
  Layer.provideMerge(PgLive),
);
// ChatRepo claims attachments inside its own transactions, so AttachmentRepo
// has to be provided to it rather than merged beside it.
const ReposLayer = Layer.mergeAll(
  AnalyticsRepo.layer,
  AgentRepo.layer,
  ChatRepo.layer,
  CustomToolRepo.layer,
  MemoryRepo.layer,
  OAuthRepo.layer,
  SignupRepo.layer,
  ProviderRepo.layer,
  ToolsRepo.layer,
  SearchProviderRepo.layer,
  GroupRepo.layer,
  FeaturePolicy.layer,
  UsageLimits.layer,
  IntegrationRepo.layer,
  KnowledgeRepo.layer,
  SkillRepo.layer,
  ScheduleRepo.layer,
  ConnectedApps.layer,
  ApiKeys.layer,
).pipe(Layer.provideMerge(AttachmentRepo.layer), Layer.provideMerge(InfraLayer));
const ToolsLayer = Layer.mergeAll(
  WebSearchExecutor.layer,
  UrlReaderExecutor.layer,
  MapLookups.layer,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      SearchProviders.layer,
      PageExtractor.layer.pipe(Layer.provide(DocumentParser.layer)),
    ),
  ),
);
const CustomToolsLayer = CustomToolBuilder.layer.pipe(
  Layer.provideMerge(CustomToolInstaller.layer),
  Layer.provideMerge(CustomToolRuntime.layer),
);
// CoreLayer feeds both sides of the top merge. StreamEngine.provideMerge'd
// draft services (AgentDraftService, ScheduleDraftService) each resolve their
// own DraftService + repo layers with Db, SyncBus, and the provider/agent
// repos taken from CoreLayer's services, so the bus and the database stay
// single instances.
const CoreLayer = Layer.mergeAll(
  AiGateway.layer,
  ExternalCompletion.layer,
  ToolsLayer,
  CustomToolsLayer,
  AttachmentService.layer,
  DocumentParser.layer,
  PresentationProcessor.layer.pipe(Layer.provideMerge(PresentationFonts.layer)),
  SpreadsheetProcessor.layer,
  WordProcessor.layer,
  DraftService.layer,
  IntegrationService.layer,
  IntegrationApprovals.layer,
  ProjectService.layer,
  SidebarPinsService.layer,
  ScheduleSettlement.layer.pipe(Layer.provideMerge(NotificationService.layer)),
).pipe(Layer.provideMerge(SyncBus.layer), Layer.provideMerge(ReposLayer));
// Knowledge indexing sits above the gateway and the parser: it embeds through
// one and extracts through the other.
const KnowledgeLayer = Layer.mergeAll(
  KnowledgeIndexer.workers.pipe(Layer.provideMerge(KnowledgeIndexer.layer)),
  KnowledgeSearch.layer,
  KnowledgeService.layer,
  KnowledgeSourceService.layer,
  ToolListingSweep,
  AgentService.layer,
  AgentDraftService.layer,
  SharingService.layer,
  SkillService.layer,
  ProjectFileService.layer,
  KeptWorkingFiles.layer,
).pipe(Layer.provideMerge(EmbeddingSpace.layer), Layer.provideMerge(CoreLayer));
const CoreWithMemoryLayer = MemoryService.layer.pipe(Layer.provideMerge(KnowledgeLayer));
const StreamedLayer = StreamEngine.layer.pipe(Layer.provideMerge(CoreWithMemoryLayer));
// The scheduler fires through chat; ScheduleFire is that one coupling. Its
// layer is provided ChatService from the merge below rather than wiring the
// whole ScheduleService layer behind it. ScheduleDraftService is provideMerge'd
// by StreamEngine's layer itself, like AgentDraftService.
const ScheduleLayer = ScheduleService.layer.pipe(
  Layer.provideMerge(ScheduleFire.layer.pipe(Layer.provide(ChatService.layer))),
);
const AppLayer = Layer.mergeAll(ChatService.layer, ScheduleLayer).pipe(
  Layer.provideMerge(StreamedLayer),
);

const memoMap = Layer.makeMemoMapUnsafe();

// Vite re-executes this module on any layer-graph change but never fires
// import.meta.hot.dispose for server modules, so each evaluation must dispose
// the previous runtime (pg pool, LISTEN connection, generation fibers) before
// taking over. Otherwise repo/service edits would silently not apply until a
// manual restart. Production runs once; nothing to dispose.
const globalKey = Symbol.for("chat/server/runtime");
type GlobalWithRuntime = typeof globalThis & {
  [globalKey]?: ManagedRuntime.ManagedRuntime<
    Layer.Success<typeof AppLayer>,
    Layer.Error<typeof AppLayer>
  >;
};

const g = globalThis as GlobalWithRuntime;

g[globalKey]?.dispose().catch((error: unknown) => {
  console.error("disposing the previous dev runtime failed", error);
});
export const runtime = (g[globalKey] = ManagedRuntime.make(AppLayer, { memoMap }));
