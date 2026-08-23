import { Layer, ManagedRuntime } from "effect";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { DocumentParser } from "~/modules/attachments/server/document-parser.ts";
import { fsBlobStoreLayer } from "~/modules/attachments/server/fs-blob-store.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { ChatService } from "~/modules/chat/server/service.ts";
import { StreamEngine } from "~/modules/chat/server/streaming.ts";
import { GroupRepo } from "~/modules/groups/server/repo.ts";
import { AiGateway } from "~/modules/providers/server/gateway.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { PageExtractor } from "~/modules/tools/server/extraction.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import { SearchBackend } from "~/modules/tools/server/search.ts";
import { WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import { Db, PgLive } from "./db.ts";

// Application layer graph. Server functions and routes run effects against
// this shared runtime; its resources (pg pool, pubsub relays, in-flight
// generation fibers) live until the next dev reload replaces it — for the
// process lifetime in production.
const InfraLayer = Layer.mergeAll(Db.layer, KeyCipher.layer, fsBlobStoreLayer).pipe(
  Layer.provideMerge(PgLive),
);
// ChatRepo claims attachments inside its own transactions, so AttachmentRepo
// has to be provided to it rather than merged beside it.
const ReposLayer = Layer.mergeAll(
  AnalyticsRepo.layer,
  ChatRepo.layer,
  ProviderRepo.layer,
  ToolsRepo.layer,
  GroupRepo.layer,
).pipe(Layer.provideMerge(AttachmentRepo.layer), Layer.provideMerge(InfraLayer));
const ToolsLayer = WebSearchExecutor.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(SearchBackend.searxngLayer, PageExtractor.layer)),
);
const CoreLayer = Layer.mergeAll(
  AiGateway.layer,
  SyncBus.layer,
  ToolsLayer,
  AttachmentService.layer,
  DocumentParser.layer,
).pipe(Layer.provideMerge(ReposLayer));
const AppLayer = ChatService.layer.pipe(
  Layer.provideMerge(StreamEngine.layer.pipe(Layer.provideMerge(CoreLayer))),
);

const memoMap = Layer.makeMemoMapUnsafe();

// Vite's dev server re-executes this module whenever anything in the layer
// graph changes, but never runs import.meta.hot.dispose hooks for server
// modules — so each evaluation replaces the previous generation itself:
// dispose the old runtime (pg pool, LISTEN connection, generation fibers)
// and take over. Serving the old graph instead would mean repo/service edits
// silently don't apply until a manual restart. In production the module runs
// once and there is nothing to dispose.
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
