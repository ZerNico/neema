// The last tree each finished block drew, kept on this device so a reload
// shows the block at once instead of a placeholder that then resizes. Keyed by
// block (message, attempt, ordinal) and source hash: a retry or another source
// never finds an old tree. The live runtime takes over when it is ready.

import { deviceCache } from "~/modules/cache/client/device-cache.ts";
import { catalogReference } from "../catalog.ts";
import { hashSource } from "../fences.ts";
import type { RenderReply } from "./engine.ts";

export type DrawnTree = Extract<RenderReply, { ok: true }>;

const trees = deviceCache<DrawnTree>({
  namespace: "genui-trees",
  maxBytes: 2 * 1024 * 1024,
  // The Worker boundary's own cap on a tree.
  maxEntryBytes: 256 * 1024,
});

/**
 * Trees were validated against the catalog of the build that drew them. A new
 * build may tighten it, so its trees are never read: their keys stop matching
 * and the budget evicts them.
 */
const CATALOG_VERSION = hashSource(catalogReference());

const keyOf = (block: string, code: string) => `${CATALOG_VERSION}|${block}|${hashSource(code)}`;

export const cachedTree = (block: string, code: string): DrawnTree | undefined =>
  trees.get(keyOf(block, code));

export const keepTree = (block: string, code: string, tree: DrawnTree): void =>
  trees.set(keyOf(block, code), tree);

export const warmTrees = (): Promise<void> => trees.warm();
