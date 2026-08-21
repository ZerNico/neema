import { Layer, ManagedRuntime } from "effect";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { ChatService } from "~/modules/chat/server/service.ts";
import { StreamEngine } from "~/modules/chat/server/streaming.ts";
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
// generation fibers) live for the process lifetime.
// NOTE: server layers don't HMR — restart `pnpm dev` after changing this graph.
const InfraLayer = Layer.mergeAll(Db.layer, KeyCipher.layer).pipe(Layer.provideMerge(PgLive));
const ReposLayer = Layer.mergeAll(ChatRepo.layer, ProviderRepo.layer, ToolsRepo.layer).pipe(
  Layer.provideMerge(InfraLayer),
);
const ToolsLayer = WebSearchExecutor.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(SearchBackend.searxngLayer, PageExtractor.layer)),
);
const CoreLayer = Layer.mergeAll(AiGateway.layer, SyncBus.layer, ToolsLayer).pipe(
  Layer.provideMerge(ReposLayer),
);
const AppLayer = ChatService.layer.pipe(
  Layer.provideMerge(StreamEngine.layer.pipe(Layer.provideMerge(CoreLayer))),
);

const memoMap = Layer.makeMemoMapUnsafe();

// Vite dev server re-imports modules on HMR; keep one runtime per process.
const globalKey = Symbol.for("chat/server/runtime");
type GlobalWithRuntime = typeof globalThis & {
  [globalKey]?: ManagedRuntime.ManagedRuntime<
    Layer.Success<typeof AppLayer>,
    Layer.Error<typeof AppLayer>
  >;
};

const g = globalThis as GlobalWithRuntime;

export const runtime = (g[globalKey] ??= ManagedRuntime.make(AppLayer, { memoMap }));
