import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

// No database is needed to serve a generic shell, even on a protected deep link.
const child = spawn(process.execPath, [fileURLToPath(new URL("./start.mjs", import.meta.url))], {
  env: {
    ...process.env,
    DATABASE_URL: "postgresql://invalid:invalid@127.0.0.1:1/disabled",
    NODE_ENV: "production",
    NITRO_HOST: "127.0.0.1",
    NITRO_PORT: "0",
    NO_COLOR: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
const closed = once(child, "close");
try {
  const origin = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 15000);
    const failed = (error) => {
      clearTimeout(deadline);
      reject(error);
    };
    child.once("error", failed);
    child.once("exit", (code) => failed(new Error(`Server exited (${code}): ${output}`)));
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const address = /Listening on:\s+(http:\/\/[^\s]+)/.exec(output)?.[1];
      if (address) {
        clearTimeout(deadline);
        resolve(address);
      }
    });
  });
  for (const path of [
    "/",
    "/login",
    "/settings/profile",
    "/chat/startup-smoke",
    "/unknown-startup-page",
  ]) {
    const response = await fetch(new URL(path, origin), {
      headers: { accept: "text/html", "sec-fetch-dest": "document" },
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    const html = await response.text();
    assert.equal(
      response.status,
      path === "/unknown-startup-page" ? 404 : 200,
      `${path}: ${html.slice(0, 200)}`,
    );
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self' 'sha256-/);
    assert.doesNotMatch(csp, /script-src [^;]*'unsafe-inline'/);
    assert.match(html, /Loading Chat…/);
    assert.match(html, /id="desktop-titlebar-content"/);
    console.log(`Shell: ${path}`);
  }
  for (const path of [
    "/api/startup-missing",
    "/_serverFn/startup-missing",
    "/assets/startup-missing.js",
  ]) {
    const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(10000) });
    assert.ok(response.status >= 400, `${path} unexpectedly returned ${response.status}`);
    assert.doesNotMatch(await response.text(), /Loading Chat…/);
    console.log(`Not a shell: ${path} (${response.status})`);
  }
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await closed;
}
console.log("Checked production SPA startup without database access.");
