import type { UiLookups } from "../../assistant-output.ts";
import type { ChunkKind } from "../repo.ts";

/**
 * Live chunk events fanned out to SSE subscribers on this instance.
 * Replay across instances/reloads always comes from Postgres, so this PubSub
 * only needs to carry chunks for in-flight generations.
 */
export interface ChunkEvent {
  readonly messageId: string;
  readonly generationId?: string;
  readonly seq: number;
  readonly chunkKind: ChunkKind;
  readonly delta: string;
  /** When it was written; absent on a live chunk, which is sent as it happens. */
  readonly at?: number;
}

export interface DoneEvent {
  readonly messageId: string;
  readonly generationId?: string;
  readonly status: "complete" | "error" | "aborted";
}

/**
 * What a generation is doing before it has anything to show, such as reading
 * scanned pages. Live only: never a chunk, so it takes no `seq`; null clears it.
 */
export interface StatusEvent {
  readonly messageId: string;
  readonly generationId?: string;
  readonly reading: { readonly read: number; readonly total: number } | null;
}

/**
 * What the answer's ```ui blocks looked up so far: images, places, routes.
 * Like status, never a chunk: the row holds them and a late subscriber gets
 * a snapshot, so a repeated event only restates what the client has.
 */
export interface LookupsEvent {
  readonly messageId: string;
  readonly generationId?: string;
  readonly lookups: UiLookups;
}

/** The latest in-progress image of a running image call, by its row id. Never persisted. */
export interface PreviewEvent {
  readonly messageId: string;
  readonly generationId?: string;
  readonly callId: string;
  readonly mediaType: string;
  /** Base64; the client draws it as a data URI. */
  readonly data: string;
}

export type StreamEvent =
  | ({ readonly kind: "chunk" } & ChunkEvent)
  | ({ readonly kind: "status" } & StatusEvent)
  | ({ readonly kind: "lookups" } & LookupsEvent)
  | ({ readonly kind: "preview" } & PreviewEvent)
  | ({ readonly kind: "done" } & DoneEvent);
