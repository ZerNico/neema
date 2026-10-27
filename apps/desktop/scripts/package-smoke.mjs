// Run by a packaged app in Node mode (ELECTRON_RUN_AS_NODE=1): loads microsandbox's native
// binding from the app's own node_modules, so a trimmed package that lost it fails here.
// Usage: package-smoke.mjs <app resources/app>
import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const [app] = process.argv.slice(2);
// Resolved from where it really is, as Node does for the binding itself (pnpm links it in dev).
const require = createRequire(
  realpathSync(join(app, "node_modules", "microsandbox", "package.json")),
);
const binding = require("./native/index.cjs");
if (typeof binding !== "object" || binding === null || Object.keys(binding).length === 0) {
  console.error("microsandbox's native binding loaded empty");
  process.exit(1);
}
// The VM runner sits beside the binding; without it no chat VM can start.
const native = dirname(require.resolve(`@superradcompany/microsandbox-${target()}/package.json`));
const runner = join(native, "bin", process.platform === "win32" ? "msb.exe" : "msb");
if (!existsSync(runner)) {
  console.error(`msb is missing: ${runner}`);
  process.exit(1);
}
console.log("microsandbox loads", runner);

function target() {
  const arch = process.arch;
  if (process.platform === "darwin") return `darwin-${arch}`;
  if (process.platform === "win32") return `win32-${arch}-msvc`;
  return `linux-${arch}-gnu`;
}
