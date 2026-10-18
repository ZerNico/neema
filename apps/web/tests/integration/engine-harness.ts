import { PgClient } from "@effect/sql-pg";
import { Layer, Redacted } from "effect";
import { AgentDraftService } from "~/modules/agents/server/draft-service.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { KeptWorkingFiles } from "~/modules/chat/server/kept-working-files.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { ChatService } from "~/modules/chat/server/service.ts";
import { StreamEngine } from "~/modules/chat/server/streaming.ts";
import { CustomToolRepo } from "~/modules/custom-tools/server/repo.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { GroupRepo } from "~/modules/groups/server/repo.ts";
import { IntegrationRepo } from "~/modules/integrations/server/repo.ts";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { MemoryRepo } from "~/modules/memory/server/repo.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import type { AiGateway } from "~/modules/providers/server/gateway.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { ScheduleDraftService } from "~/modules/schedules/server/draft-service.ts";
import { ScheduleRepo } from "~/modules/schedules/server/repo.ts";
import { SkillRepo } from "~/modules/skills/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { ExternalCompletion } from "~/modules/tools/server/external-completion.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import { Db } from "~/server/db.ts";
import { FakeMemoryService } from "./fake-memory.ts";
import {
  FakeBlobStore,
  FakeCustomToolRuntime,
  FakeDocumentParser,
  FakeKnowledge,
  FakeUrlReader,
  FakeWebSearch,
  fakeGateway,
  NoIntegrations,
} from "./unused-services.ts";

// Every repo the engine and its optional readers (ToolsRepo) can reach, as in
// src/server/runtime.ts, so each suite tests the same engine.
const baseLayer = (url: string, maxConnections: number) =>
  Layer.mergeAll(
    AnalyticsRepo.layer,
    AgentRepo.layer,
    ChatRepo.layer,
    CustomToolRepo.layer,
    MemoryRepo.layer,
    ProviderRepo.layer,
    ToolsRepo.layer,
    GroupRepo.layer,
    FeaturePolicy.layer,
    IntegrationRepo.layer,
    KnowledgeRepo.layer,
    SkillRepo.layer,
    ScheduleRepo.layer,
    SyncBus.layer,
  ).pipe(
    Layer.provideMerge(AttachmentRepo.layer),
    Layer.provideMerge(
      Layer.mergeAll(Db.layer, KeyCipher.layer).pipe(
        Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections })),
      ),
    ),
  );

/** Database, repos and the sync bus: what a `services` replacement may build on. */
export type HarnessBase = Layer.Success<ReturnType<typeof baseLayer>>;

const defaultServices = (gateway: Partial<AiGateway["Service"]> | undefined) =>
  Layer.mergeAll(
    fakeGateway(gateway),
    FakeWebSearch,
    FakeUrlReader,
    FakeBlobStore,
    FakeDocumentParser,
    FakeCustomToolRuntime,
    NoIntegrations,
    FakeMemoryService,
    ExternalCompletion.layer,
    ScheduleDraftService.layer,
    AgentDraftService.layer,
  );

/** Everything a `knowledge` replacement may build on: base, services and attachments. */
export type HarnessCore =
  | HarnessBase
  | Layer.Success<ReturnType<typeof defaultServices>>
  | AttachmentService
  | KeptWorkingFiles;

export interface EngineHarnessOptions<S, ES, K, EK> {
  readonly maxConnections?: number;
  /** Methods of the fake provider; the rest die when called. */
  readonly gateway?: Partial<AiGateway["Service"]>;
  /**
   * Merged after the default fakes, so a service here replaces its fake: a
   * scripted web search or reader, a real memory service, a blob store that
   * keeps bytes, or an optional engine dependency such as `MapLookups`.
   */
  readonly services?: Layer.Layer<S, ES, HarnessBase>;
  /** Replaces `FakeKnowledge`; built over attachments so a real library can index. */
  readonly knowledge?: Layer.Layer<K, EK, HarnessCore>;
}

/**
 * The stream engine and ChatService over a real database, with every
 * collaborator a suite does not exercise faked. Returns a Layer, so a suite can
 * stack its own services on top or build two runtimes from it.
 */
export const engineLayer = <S = never, ES = never, K = never, EK = never>(
  url: string,
  options: EngineHarnessOptions<S, ES, K, EK> = {},
) => {
  // Built once: a second reference would open a second pool and sync bus.
  const base = baseLayer(url, options.maxConnections ?? 5);
  const core = Layer.mergeAll(
    defaultServices(options.gateway),
    options.services ?? Layer.empty,
  ).pipe(Layer.provideMerge(base));
  const files = KeptWorkingFiles.layer.pipe(
    Layer.provideMerge(AttachmentService.layer),
    Layer.provideMerge(core),
  );
  const knowledge = Layer.mergeAll(FakeKnowledge, options.knowledge ?? Layer.empty).pipe(
    Layer.provideMerge(files),
  );
  return ChatService.layer.pipe(
    Layer.provideMerge(StreamEngine.layer.pipe(Layer.provideMerge(knowledge))),
  );
};
