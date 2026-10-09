// Starts what a ui block waits for as soon as a chat shows one: the device's
// cached trees, the renderer's code and the QuickJS Worker, side by side
// rather than one after another once the first block mounts.

import { loadUiBlock } from "../ui/load-block.ts";
import { warmTrees } from "./tree-cache.ts";

let renderer: Promise<unknown> | null = null;

/** Starts everything; resolves once the renderer's code has loaded, which a cached tree needs to show. */
export function prewarmGenui(): Promise<unknown> {
  if (typeof window === "undefined") return Promise.resolve();
  if (renderer) return renderer;
  void warmTrees();
  if (typeof Worker === "function")
    void import("./host.ts").then((host) => host.warmSharedWorker());
  renderer = loadUiBlock().catch(() => {});
  return renderer;
}
