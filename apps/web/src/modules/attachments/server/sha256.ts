import { createHash } from "node:crypto";

/** Hex SHA-256: blob identity, working-file fingerprints and preview cache keys all agree on it. */
export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
