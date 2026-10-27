import { spawn } from "node:child_process";
import { context } from "esbuild";
import { buildAppDriver, buildOptions } from "./build.mjs";
import { compileMessages } from "./paraglide.ts";
import { electronBinary } from "./electron-app.mjs";
import { makeDevReloader } from "./src/dev-reloader.ts";

// Rebuilding interrupts local Work, so retire its execution host before replacing it.
const reloader = makeDevReloader({
  spawn: () =>
    spawn(electronBinary(), ["dist/main.cjs"], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        CHAT_DESKTOP_DEV_RELOAD: "1",
        CHAT_DESKTOP_SERVER: process.env.CHAT_DESKTOP_SERVER ?? "http://localhost:3000",
      },
    }),
  quit: () => {
    void shutdown();
  },
  reportError: (cause) => console.error("[desktop] restart failed", cause),
});

await compileMessages();
// Once per start: the shell relaunches on TypeScript changes, not on the driver's Swift.
buildAppDriver();
const ctx = await context({
  ...buildOptions(),
  plugins: [
    {
      name: "relaunch",
      setup(build) {
        build.onEnd(async (result) => {
          if (result.errors.length > 0) return;
          console.log(`[desktop] rebuilt ${new Date().toLocaleTimeString()}, relaunching`);
          await reloader.restart();
        });
      },
    },
  ],
});

let shutdownPromise;
function shutdown() {
  shutdownPromise ??= reloader
    .stop()
    .then(() => ctx.dispose())
    .then(() => process.exit(0))
    .catch((cause) => {
      console.error("[desktop] shutdown failed", cause);
      process.exit(1);
    });
  return shutdownPromise;
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
await ctx.watch();
