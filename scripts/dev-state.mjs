import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Errors marked safe are user-actionable and carry no connection secrets.
export function safeError(message, options) {
  return Object.assign(new Error(message, options), { safe: true });
}

export function instancePaths(root) {
  // Checkout identity survives branch switches; it is never derived from untrusted SQL names.
  const id = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const directory = join(root, ".data", "dev");
  return {
    root,
    id,
    database: `chat_dev_${id}`,
    directory,
    config: join(directory, "instance.json"),
    origin: join(directory, "origin.txt"),
    blobs: join(directory, "storage"),
    profile: join(directory, "desktop"),
  };
}

export async function loadInstance(root, create = false) {
  const paths = instancePaths(await realpath(root));
  if (create) {
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    const config = {
      id: paths.id,
      databasePassword: randomBytes(32).toString("hex"),
      authSecret: randomBytes(32).toString("hex"),
      providerSecret: randomBytes(32).toString("base64"),
    };
    try {
      await writeFile(paths.config, JSON.stringify(config, null, 2), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  let config;
  try {
    config = JSON.parse(await readFile(paths.config, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error("Run pnpm dev:setup in this checkout first.", { cause: error });
    throw error;
  }
  if (
    config.id !== paths.id ||
    !/^[a-f0-9]{64}$/.test(config.databasePassword) ||
    !/^[a-f0-9]{64}$/.test(config.authSecret) ||
    !/^[A-Za-z0-9+/]{43}=$/.test(config.providerSecret)
  ) {
    throw new Error("Invalid dev instance configuration. Do not copy .data/dev between checkouts.");
  }
  if (config.snapshot !== undefined && !/^[a-f0-9]{16}$/.test(config.snapshot)) {
    throw new Error("Invalid dev snapshot identity.");
  }
  const snapshot = config.snapshot;
  return {
    ...paths,
    ...(snapshot
      ? {
          database: `${paths.database}_${snapshot}`,
          blobs: join(paths.directory, "snapshots", snapshot, "storage"),
          profile: join(paths.directory, "snapshots", snapshot, "desktop"),
        }
      : {}),
    snapshot,
    databasePassword: config.databasePassword,
    authSecret: config.authSecret,
    providerSecret: config.providerSecret,
  };
}

// One rename selects the database, blobs, profile and keys together.
export async function activateSnapshot(instance, snapshot, providerSecret) {
  if (!/^[a-f0-9]{16}$/.test(snapshot) || !/^[A-Za-z0-9+/]{43}=$/.test(providerSecret)) {
    throw new Error("Invalid snapshot configuration.");
  }
  const config = JSON.parse(await readFile(instance.config, "utf8"));
  const temporary = join(instance.directory, `activate-${randomBytes(12).toString("hex")}.tmp`);
  await writeFile(temporary, JSON.stringify({ ...config, snapshot, providerSecret }, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  try {
    await rename(temporary, instance.config);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export function instanceEnv(instance, inherited = process.env) {
  return {
    ...inherited,
    DATABASE_URL: `postgres://chat_dev_${instance.id}:${instance.databasePassword}@127.0.0.1:5433/${instance.database}`,
    BETTER_AUTH_SECRET: instance.authSecret,
    PROVIDER_KEY_SECRET: instance.providerSecret,
    BLOB_STORE_ROOT: instance.blobs,
    CHAT_DESKTOP_PROFILE: instance.profile,
    // Pinned, verified files that never change: shared by every snapshot of this checkout.
    OCR_MODEL_ROOT: join(instance.directory, "ocr-models"),
  };
}

export function publicOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Expected an HTTP(S) development origin.");
  }
  return url.origin;
}
