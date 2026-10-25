import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// The route tree and the compiled messages are gitignored and only their Vite
// plugins write them, so a fresh checkout cannot typecheck or test until Vite
// has started.

// On GitHub's runners the server never finished closing and the job hung until
// its timeout, so this exits itself once the files exist.
const outputs = [
  "../src/routeTree.gen.ts",
  "../src/paraglide/messages.d.ts",
  "../src/paraglide/runtime.d.ts",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

setTimeout(() => {
  console.error("Generation did not finish within 120s.");
  process.exit(1);
}, 120_000).unref();

console.log("Starting Vite to generate the route tree and messages…");
const server = await createServer({
  server: { middlewareMode: true, hmr: false, watch: null },
  logLevel: "warn",
});
while (!outputs.every((path) => existsSync(path))) await sleep(100);
console.log("Route tree and messages generated.");
await Promise.race([server.close(), sleep(10_000)]);
process.exit(0);
