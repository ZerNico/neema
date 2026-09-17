import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadInstance } from "./dev-state.mjs";
import { registerRuntime, runtimeRequest, withMaintenance } from "./dev-lifecycle.mjs";

async function instance(t) {
  const root = await mkdtemp(join(tmpdir(), "chat-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return loadInstance(root, true);
}

test("runtime proves identity and accepts stop without signalling arbitrary PIDs", async (t) => {
  const state = await instance(t);
  let stopped;
  const stopping = new Promise((resolve) => { stopped = resolve; });
  const close = await registerRuntime(state, "web", stopped, "https://chat.localhost");
  try {
    const info = await runtimeRequest(state, "web");
    assert.equal(info.pid, process.pid);
    assert.equal(info.origin, "https://chat.localhost");
    await assert.rejects(withMaintenance(state, () => assert.fail("live destination")), /Cannot lock web/);
    let acknowledged = false;
    const request = runtimeRequest(state, "web", "stop").then((reply) => {
      acknowledged = true;
      return reply;
    });
    await stopping;
    await assert.rejects(withMaintenance(state, () => assert.fail("still stopping")), /Cannot lock web/);
    assert.equal(acknowledged, false, "stop must not acknowledge before runtime cleanup");
    await close();
    assert.equal((await request).pid, process.pid);
  } catch (error) { await close(); throw error; }
  assert.equal(await runtimeRequest(state, "web"), null);
  await withMaintenance(state, async () => {});
});

test("maintenance excludes startup and other maintenance until it finishes", async (t) => {
  const state = await instance(t);
  await withMaintenance(state, async () => {
    await assert.rejects(registerRuntime(state, "desktop", () => {}), /Cannot lock maintenance/);
    await assert.rejects(withMaintenance(state, () => {}), /Cannot lock maintenance/);
  });
  const close = await registerRuntime(state, "desktop", () => {});
  await close();
});
