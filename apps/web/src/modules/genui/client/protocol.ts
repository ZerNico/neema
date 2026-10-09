// Messages between the page and the ui-block Worker.

import type { CallReply, CallRequest, RenderReply, RenderRequest } from "./engine.ts";

export type WorkerRequest =
  | { readonly id: number; readonly op: "render"; readonly request: RenderRequest }
  | { readonly id: number; readonly op: "call"; readonly request: CallRequest }
  | { readonly id: number; readonly op: "release"; readonly block: string };

export type WorkerMessage =
  /** The request began executing; the page's watchdog times only from here. */
  | { readonly id: number; readonly started: true }
  | { readonly id: number; readonly reply: RenderReply | CallReply | null }
  /** QuickJS could not load at all; every block falls back to its source. */
  | { readonly fatal: string };
