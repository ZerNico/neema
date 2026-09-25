import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Served from a copy outside the repository, as a deployment would be: here a
// module missing from .output still resolves from apps/web/node_modules.
const deployment = await mkdtemp(join(tmpdir(), "chat-production-start-"));
await cp(fileURLToPath(new URL("../.output", import.meta.url)), join(deployment, ".output"), {
  recursive: true,
  verbatimSymlinks: true,
});
await cp(
  fileURLToPath(new URL("./start.mjs", import.meta.url)),
  join(deployment, "scripts", "start.mjs"),
);

// No database is needed to serve a generic shell, even on a protected deep link.
const child = spawn(process.execPath, [join(deployment, "scripts", "start.mjs")], {
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
let stdout = "";
let stderr = "";
const closed = once(child, "close");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
try {
  const origin = await new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`Server did not start: ${stdout}\n${stderr}`)),
      15000,
    );
    const failed = (error) => {
      clearTimeout(deadline);
      reject(error);
    };
    child.once("error", failed);
    child.once("exit", (code) =>
      failed(new Error(`Server exited (${code}): ${stdout}\n${stderr}`)),
    );
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const address = /Listening on:\s+(http:\/\/[^\s]+)/.exec(stdout)?.[1];
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
    assert.doesNotMatch(csp, /script-src [^;]*'unsafe-inline'/);
    // Every inline script must carry this response's nonce, or the browser
    // refuses it and the shell never boots. Serving HTML proves nothing more.
    const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce, `${path}: no script nonce in ${csp}`);
    const inline = [...html.matchAll(/<script\b(?![^>]*\bsrc=)([^>]*)>/g)];
    assert.ok(inline.length > 0, `${path}: no inline scripts`);
    for (const [tag, attributes] of inline) {
      assert.ok(attributes.includes(`nonce="${nonce}"`), `${path}: ${tag}`);
    }
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(html, /data-slot="spinner"/);
    assert.match(html, /id="desktop-titlebar-content"/);
    console.log(`Shell: ${path}`);
  }
  for (const path of ["/api/startup-missing", "/assets/startup-missing.js"]) {
    const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(10000) });
    const body = await response.text();
    assert.equal(response.status, 404, `${path}: ${body.slice(0, 200)}`);
    assert.doesNotMatch(body, /data-slot="spinner"/);
    console.log(`Not a shell: ${path} (${response.status})`);
  }
  // Server functions refuse anything not proven same-origin (src/start.ts).
  const refusals = await Promise.all(
    [
      ["cross-site", { "sec-fetch-site": "cross-site" }],
      ["no origin headers", {}],
    ].map(async ([label, headers]) => {
      const response = await fetch(new URL("/_serverFn/startup-missing", origin), {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      await response.text();
      return [label, response.status];
    }),
  );
  for (const [label, status] of refusals) {
    assert.equal(status, 403, `server function, ${label}`);
    console.log(`Refused server function call: ${label} (${status})`);
  }
  const missingFunction = await fetch(new URL("/_serverFn/startup-missing", origin), {
    headers: { "sec-fetch-site": "same-origin" },
    signal: AbortSignal.timeout(10000),
  });
  const body = await missingFunction.text();
  // Start's dispatcher rejects an unknown function before our 404 document
  // fallback. Assert its specific failure, not any arbitrary server error.
  assert.equal(missingFunction.status, 500, body.slice(0, 200));
  assert.match(missingFunction.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(JSON.parse(body), { status: 500, unhandled: true, message: "HTTPError" });
  const diagnostic = "Server function info not found for startup-missing";
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(deadline);
      child.stderr.off("data", checkDiagnostic);
      child.off("exit", exited);
      child.off("error", rejectEarly);
    };
    const rejectEarly = (error) => {
      cleanup();
      reject(error);
    };
    const exited = (code, signal) =>
      rejectEarly(new Error(`Server exited (${code ?? signal}) before diagnostic: ${stderr}`));
    const checkDiagnostic = () => {
      if (!stderr.includes(diagnostic)) return;
      cleanup();
      resolve();
    };
    const deadline = setTimeout(
      () => rejectEarly(new Error(`Missing server function diagnostic: ${stderr}`)),
      10000,
    );
    child.stderr.on("data", checkDiagnostic);
    child.once("exit", exited);
    child.once("error", rejectEarly);
    if (child.exitCode !== null || child.signalCode !== null) {
      exited(child.exitCode, child.signalCode);
    } else {
      checkDiagnostic();
    }
  });
  console.log(`Not a shell: /_serverFn/startup-missing (${missingFunction.status})`);
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await closed;
  await rm(deployment, { recursive: true, force: true });
}
console.log("Checked production SPA startup without database access.");
