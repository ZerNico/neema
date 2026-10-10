import { applyChange } from "@chat/sheet/model/apply";
import type { SheetDoc } from "@chat/sheet/model";
import type { SheetChange, SheetOp } from "@chat/sheet/model/ops";
import { SHEET_TRANSPORT } from "../schema.ts";
import type {
  PushSheetInput,
  PushSheetResult,
  SheetCursor,
  SheetFrame,
  SheetMoment,
  SheetPresence,
} from "../schema.ts";
import type { DocumentComment } from "../../schema.ts";

export type SheetSyncStatus = "connecting" | "live" | "offline" | "gone";
/** The part of an EventSource the connection uses; tests stand in a fake. */
export interface SheetFeedSource {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}
export interface SheetSyncOptions {
  documentId: string;
  push: (input: PushSheetInput) => Promise<PushSheetResult>;
  /** Replaceable in tests; the browser's EventSource otherwise. */
  connect?: (url: string) => SheetFeedSource;
  /** Replaceable in tests; a fresh random one otherwise. */
  clientId?: string;
}

/** What the sheet shows now: the server's document with this tab's unsent changes on top. */
export interface SheetState {
  readonly doc: SheetDoc | null;
  readonly revision: number;
  readonly moment: SheetMoment;
  readonly status: SheetSyncStatus;
  readonly comments: ReadonlyArray<DocumentComment>;
  readonly presence: ReadonlyMap<string, SheetPresence>;
  /** Why the last changes did not apply, for the person to see. */
  readonly refused: string | null;
  readonly pending: number;
}

const FRAME_TYPES = ["reset", "changes", "comments", "presence", "gone"] as const;
/** Edits inside this window travel as one push. */
const BATCH_MS = 60;
const MAX_BACKOFF_MS = 10_000;
const NO_MOMENT: SheetMoment = { now: 0, seed: 0 };

/**
 * One open sheet's connection. The feed brings the server's order; edits
 * are applied here at once and replayed over every change the feed brings
 * until the server acknowledges them by sequence number. Applying is total,
 * so replaying needs no rebasing.
 */
export class SheetSync {
  readonly clientId: string;
  #confirmed: SheetDoc | null = null;
  #revision = 0;
  #moment = NO_MOMENT;
  #pending: SheetChange[] = [];
  #seq = 0;
  #minted = 0;
  #view: SheetDoc | null = null;
  #status: SheetSyncStatus = "connecting";
  #comments: ReadonlyArray<DocumentComment> = [];
  #presence = new Map<string, SheetPresence>();
  #refused: string | null = null;
  #cursor: SheetCursor | null = null;
  #cursorDirty = false;
  #source: SheetFeedSource | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #inflight: Promise<void> | null = null;
  #failures = 0;
  #attempt = 0;
  #destroyed = false;
  #listeners = new Set<() => void>();
  #state: SheetState;

  constructor(private readonly options: SheetSyncOptions) {
    this.clientId = options.clientId ?? crypto.randomUUID().slice(0, 18);
    this.#state = this.#snapshot();
    this.#connect();
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  getState = () => this.#state;

  /** An ID no other replica mints, for rows, columns and sheets this tab adds. */
  mint = () => `${this.clientId}.${++this.#minted}`;

  /** Applies this tab's operations now and sends them; nothing happens before the first load. */
  dispatch(ops: readonly SheetOp[]) {
    if (!this.#confirmed || !ops.length || this.#status === "gone") return;
    this.#pending.push({ clientId: this.clientId, seq: ++this.#seq, ops });
    this.#refused = null;
    this.#rebuild();
    this.#schedule(BATCH_MS);
  }

  setCursor(cursor: SheetCursor | null) {
    this.#cursor = cursor;
    this.#cursorDirty = cursor !== null;
    if (cursor) this.#schedule(BATCH_MS);
  }

  pending = () => this.#pending.length > 0;

  /** Sends everything unsent; true once the server has it all. */
  async flush(): Promise<boolean> {
    for (let round = 0; round < 5 && this.#pending.length && this.#status !== "gone"; round++) {
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = null;
      await this.#send();
      if (this.#failures) return false;
    }
    return this.#pending.length === 0;
  }

  destroy() {
    this.#destroyed = true;
    this.#source?.close();
    for (const timer of [this.#timer, this.#reconnectTimer]) if (timer) clearTimeout(timer);
    this.#listeners.clear();
  }

  #snapshot(): SheetState {
    return {
      doc: this.#view,
      revision: this.#revision,
      moment: this.#moment,
      status: this.#status,
      comments: this.#comments,
      presence: new Map(this.#presence),
      refused: this.#refused,
      pending: this.#pending.length,
    };
  }
  #notify() {
    this.#state = this.#snapshot();
    for (const listener of this.#listeners) listener();
  }
  /** What the sheet shows: unsent changes replayed over what the server confirmed. */
  #rebuild() {
    let view = this.#confirmed;
    if (view)
      for (const [index, change] of this.#pending.entries())
        view = applyChange(view, change, this.#revision + index + 1).doc;
    this.#view = view;
    this.#notify();
  }
  #acknowledge(seq: number) {
    const before = this.#pending.length;
    this.#pending = this.#pending.filter((change) => change.seq > seq);
    // A reconnect after a reload starts below what the server already has.
    this.#seq = Math.max(this.#seq, seq);
    return before !== this.#pending.length;
  }

  #schedule(delay: number) {
    if (this.#timer || this.#destroyed) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#send();
    }, delay);
  }
  #send(): Promise<void> {
    if (this.#inflight) return this.#inflight;
    if (this.#status !== "live" || (!this.#pending.length && !this.#cursorDirty))
      return Promise.resolve();
    const changes = this.#pending.slice(0, SHEET_TRANSPORT.changes);
    const cursor = this.#cursorDirty ? this.#cursor : null;
    this.#cursorDirty = false;
    this.#inflight = this.options
      .push({
        documentId: this.options.documentId,
        clientId: this.clientId,
        ...(changes.length ? { changes: changes.map((change) => JSON.stringify(change)) } : {}),
        ...(cursor ? { cursor } : {}),
      })
      .then(
        (result) => {
          this.#failures = 0;
          this.#acknowledge(result.acked);
          if (result.refused.length)
            this.#refused = `Some changes weren’t kept: ${result.refused[0]!.reason}.`;
          this.#rebuild();
        },
        () => {
          this.#failures++;
          if (cursor) this.#cursorDirty = true;
        },
      )
      .finally(() => {
        this.#inflight = null;
        if (this.#pending.length || this.#cursorDirty)
          this.#schedule(this.#failures ? this.#backoff(this.#failures) : BATCH_MS);
      });
    return this.#inflight;
  }
  #backoff(attempt: number) {
    return Math.min(MAX_BACKOFF_MS, 250 * 2 ** attempt);
  }

  #connect() {
    if (this.#destroyed) return;
    const params = new URLSearchParams({ client: this.clientId });
    if (this.#confirmed) params.set("revision", String(this.#revision));
    const url = `/api/sheets/${encodeURIComponent(this.options.documentId)}/stream?${params}`;
    const source = (this.options.connect ?? ((href) => new EventSource(href)))(url);
    this.#source = source;
    const handle = (event: MessageEvent<string>) => {
      if (this.#source !== source) return;
      this.#receive(JSON.parse(event.data) as SheetFrame);
    };
    for (const type of FRAME_TYPES) source.addEventListener(type, handle);
    source.addEventListener("error", () => {
      if (this.#source !== source || this.#status === "gone") return;
      this.#reconnect();
    });
  }
  #reconnect() {
    if (this.#destroyed || this.#status === "gone" || this.#reconnectTimer) return;
    this.#source?.close();
    this.#source = null;
    this.#status = "offline";
    this.#notify();
    this.#attempt++;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, this.#backoff(this.#attempt));
  }
  #live() {
    this.#attempt = 0;
    this.#status = "live";
    this.#cursorDirty = this.#cursor !== null;
    this.#schedule(0);
  }

  #receive(frame: SheetFrame) {
    switch (frame.type) {
      case "reset":
        this.#confirmed = frame.doc;
        this.#revision = frame.revision;
        this.#moment = frame.moment;
        if (frame.acked !== null) this.#acknowledge(frame.acked);
        this.#live();
        this.#rebuild();
        return;
      case "changes": {
        if (!this.#confirmed) return;
        const start = frame.revision - frame.changes.length;
        // A gap means frames were missed; catch up from the server instead.
        if (start > this.#revision) {
          this.#reconnect();
          return;
        }
        let doc = this.#confirmed;
        for (const [index, change] of frame.changes.entries()) {
          const revision = start + index + 1;
          if (revision <= this.#revision) continue;
          doc = applyChange(doc, change, revision).doc;
          if (change.clientId === this.clientId) this.#acknowledge(change.seq);
        }
        this.#confirmed = doc;
        this.#revision = Math.max(this.#revision, frame.revision);
        this.#moment = frame.moment;
        if (this.#status !== "live") this.#live();
        this.#rebuild();
        return;
      }
      case "comments":
        this.#comments = frame.comments;
        this.#notify();
        return;
      case "presence":
        if (frame.presence) this.#presence.set(frame.clientId, frame.presence);
        else this.#presence.delete(frame.clientId);
        this.#notify();
        return;
      case "gone":
        this.#status = "gone";
        this.#source?.close();
        this.#notify();
        return;
    }
  }
}
