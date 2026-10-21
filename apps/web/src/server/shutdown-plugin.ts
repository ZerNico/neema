import { definePlugin } from "nitro";

// Found through its global rather than imported: a second evaluation of
// runtime.ts would build a second runtime and dispose the live one.
const runtimeKey = Symbol.for("chat/server/runtime");

/**
 * Nitro closes the HTTP server on SIGTERM and SIGINT, then runs this. The
 * Effect runtime's pool, LISTEN connection, job workers and timers otherwise
 * keep the process alive, so `docker stop` waited out its grace period and
 * killed it with nothing shut down.
 */
export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook("close", async () => {
    const runtime = (globalThis as { [runtimeKey]?: { dispose(): Promise<void> } })[runtimeKey];
    await runtime?.dispose().catch((error: unknown) => {
      console.error("disposing the runtime on shutdown failed", error);
    });
  });
});
