// Run by a packaged app in Node mode (ELECTRON_RUN_AS_NODE=1): loads MXC from the
// app's own node_modules, so a trimmed package that lost a native fails here.
// Usage: package-smoke.mjs <app resources/app> <writable folder> [--load-only]
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const [app, workspace, mode] = process.argv.slice(2);
const sdk = pathToFileURL(join(app, "node_modules/@microsoft/mxc-sdk/dist/v1/index.js")).href;
const { getAvailableBackends, spawn } = await import(sdk);
const backends = getAvailableBackends();
console.log("backends", JSON.stringify(backends));
if (backends.length === 0) process.exit(1);
// A runner whose OS cannot host the container still proves the library loads.
if (mode === "--load-only") process.exit(0);

const windows = process.platform === "win32";
const child = await spawn({
  command: windows ? 'cmd.exe /d /s /c "echo contained"' : "/bin/sh -c 'echo contained'",
  workingDirectory: workspace,
  filesystem: { readwritePaths: [workspace] },
  network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
  ...(windows ? { ui: { disable: false } } : {}),
  timeoutMs: 30_000,
});
const output = [];
child.standardOutput?.on("data", (chunk) => output.push(String(chunk)));
child.standardError?.on("data", (chunk) => output.push(String(chunk)));
const { exitCode } = await child.wait();
console.log("exit", exitCode, "output", output.join("").trim());
if (exitCode !== 0 || output.join("").trim() !== "contained") process.exit(1);
