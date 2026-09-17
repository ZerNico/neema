import { createServer, createConnection } from "node:net";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadInstance } from "./dev-state.mjs";

const slots = { maintenance: 0, web: 1, desktop: 2 };
function portFor(instance, slot) {
  return 20000 + (Number.parseInt(instance.id.slice(0, 8), 16) % 12000) * 3 + slots[slot];
}

// Kernel-owned locks disappear on exit. A hash collision refuses to proceed, never kills a peer.
export async function lockInstance(instance, slot) {
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(portFor(instance, slot), "127.0.0.1", resolve);
  }).catch((cause) => {
    server.close();
    throw new Error(`Cannot lock ${slot}: it is running or another checkout uses this lock port.`, { cause });
  });
  return {
    server,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

export async function withMaintenance(instance, action) {
  const gate = await lockInstance(instance, "maintenance");
  try {
    const web = await lockInstance(instance, "web");
    try {
      const desktop = await lockInstance(instance, "desktop");
      try { return await action(); } finally { await desktop.close(); }
    } finally { await web.close(); }
  } finally { await gate.close(); }
}

export async function registerRuntime(instance, slot, stop, origin = null) {
  const gate = await lockInstance(instance, "maintenance");
  let lock;
  const file = join(instance.directory, `runtime-${slot}.json`);
  const token = randomBytes(32).toString("hex");
  const waiting = new Map();
  try {
    lock = await lockInstance(instance, slot);
    instance = await loadInstance(instance.root);
    lock.server.removeAllListeners("connection");
    lock.server.on("connection", (socket) => {
      socket.setTimeout(2000, () => socket.destroy());
      let input = "";
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        input += chunk;
        if (input.length > 4096) return socket.destroy();
        if (!input.includes("\n")) return;
        let request;
        try { request = JSON.parse(input); } catch { return socket.destroy(); }
        if (request.id !== instance.id || request.token !== token) return socket.destroy();
        const reply = JSON.stringify({ id: instance.id, pid: process.pid, origin, database: instance.database }) + "\n";
        if (request.command === "stop") {
          socket.setTimeout(0);
          waiting.set(socket, reply);
          socket.on("close", () => waiting.delete(socket));
          stop();
        } else socket.end(reply);
      });
    });
    await writeFile(file, JSON.stringify({ token, id: instance.id }), { mode: 0o600 });
  } catch (error) {
    if (lock) await lock.close();
    throw error;
  } finally { await gate.close(); }
  return async () => {
    await unlink(file).catch((error) => { if (error.code !== "ENOENT") throw error; });
    const closed = lock.close();
    for (const [socket, reply] of waiting) socket.end(reply);
    await closed;
  };
}

export async function runtimeRequest(instance, slot, command = "info") {
  let descriptor;
  try { descriptor = JSON.parse(await readFile(join(instance.directory, `runtime-${slot}.json`), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: portFor(instance, slot) });
    let response = "";
    socket.setTimeout(command === "stop" ? 30000 : 2000, () => socket.destroy(new Error("Runtime did not answer; refusing to infer it is stopped.")));
    socket.on("connect", () => socket.write(JSON.stringify({ ...descriptor, command }) + "\n"));
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.length > 4096) socket.destroy(new Error("Invalid runtime response."));
    });
    socket.on("error", (error) => error.code === "ECONNREFUSED" ? resolve(null) : reject(error));
    socket.on("end", () => {
      try {
        const value = JSON.parse(response);
        if (value.id !== instance.id) throw new Error("Runtime identity mismatch.");
        resolve(value);
      } catch (cause) { reject(new Error("Runtime identity could not be verified.", { cause })); }
    });
  });
}
