// The ui-block Worker: one per page, holding every live block's QuickJS
// runtime. A hung or trapped module only ever takes this Worker down, and the
// page can terminate it (client/host.ts).

import variant from "@jitl/quickjs-wasmfile-release-sync";
import wasmLocation from "@jitl/quickjs-wasmfile-release-sync/wasm?url";
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import { BlockEngine } from "./engine.ts";
import type { WorkerMessage, WorkerRequest } from "./protocol.ts";

// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker's postMessage takes no origin
const post = (message: WorkerMessage) => self.postMessage(message);

// The wasm URL is passed explicitly rather than left to the loader's own
// import.meta.url guess, which bundlers do not all rewrite.
const engine = newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmLocation })).then(
  (module) => new BlockEngine(module),
);
engine.catch((error: unknown) =>
  post({ fatal: error instanceof Error ? error.message : String(error) }),
);

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  void engine.then((blocks) => {
    const request = event.data;
    post({ id: request.id, started: true });
    switch (request.op) {
      case "render":
        post({ id: request.id, reply: blocks.render(request.request) });
        return;
      case "call":
        post({ id: request.id, reply: blocks.call(request.request) });
        return;
      case "release":
        blocks.release(request.block);
        post({ id: request.id, reply: null });
        return;
    }
  });
});
