import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// src/routeTree.gen.ts is gitignored and only the router's Vite plugin writes
// it, so a fresh checkout cannot typecheck or test until Vite has started.

// On GitHub's runners the server never finished closing and the job hung until
// its timeout, so this exits itself once the file exists.
const tree = fileURLToPath(new URL("../src/routeTree.gen.ts", import.meta.url));

setTimeout(() => {
  console.error("Route tree generation did not finish within 120s.");
  process.exit(1);
}, 120_000).unref();

console.log("Starting Vite to generate the route tree…");
const server = await createServer({
  server: { middlewareMode: true, hmr: false, watch: null },
  logLevel: "warn",
});
while (!existsSync(tree)) await sleep(100);
console.log("Route tree generated.");
await Promise.race([server.close(), sleep(10_000)]);
process.exit(0);
