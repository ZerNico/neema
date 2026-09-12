import { spawn } from "node:child_process";
import { context } from "esbuild";
import { buildOptions } from "./build.mjs";

/**
 * The desktop dev loop: rebuild on change, relaunch Electron on rebuild.
 *
 * There is no HMR for a main process, and a preload cannot be swapped under a
 * live window, so a change means a fresh Electron. That is fine: the shell
 * has no state worth keeping between launches (the server has it all), and
 * a relaunch is under a second. What matters is that a stale bundle can never
 * be what runs, which is the mistake a manual `build && start` invites.
 */

const electronBin = new URL("./node_modules/.bin/electron", import.meta.url).pathname;
let child = null;

const launch = () => {
  const previous = child;
  previous?.kill();
  const next = spawn(electronBin, ["dist/main.cjs"], {
    stdio: "inherit",
    // The harness this may be started from sets ELECTRON_RUN_AS_NODE, which
    // turns the binary into a bare node and leaves `app` undefined.
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      CHAT_DESKTOP_SERVER: process.env.CHAT_DESKTOP_SERVER ?? "http://localhost:3000",
    },
  });
  child = next;
  next.on("exit", (code) => {
    // Quitting the app is how a developer stops the loop. A process this
    // script killed for a relaunch, or one that crashed, is not that.
    if (next === child && !next.killed && code === 0) process.exit(0);
  });
};

const ctx = await context({
  ...buildOptions(),
  plugins: [
    {
      name: "relaunch",
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length > 0) return;
          console.log(`[desktop] rebuilt ${new Date().toLocaleTimeString()}, relaunching`);
          launch();
        });
      },
    },
  ],
});

await ctx.watch();
process.on("SIGINT", () => {
  child?.kill();
  void ctx.dispose().then(() => process.exit(0));
});
