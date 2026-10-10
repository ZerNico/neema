import { applyChange } from "@chat/sheet/model/apply";
import { invertChange } from "@chat/sheet/model/invert";
import type { SheetDoc } from "@chat/sheet/model";
import type { SheetChange, SheetOp } from "@chat/sheet/model/ops";
import { SHEET_TRANSPORT } from "../schema.ts";
import type {
  PushSheetAnswer,
  PushSheetInput,
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
/**
 * Unsent changes kept on the device one by one, so a reload or a crash loses
 * none. Another tab may load the same ones and resend them: the server
 * applies each client's numbers once, so that is harmless. Only what the
 * server has answered is forgotten, never a change made since in another tab.
 */
export interface SheetOutbox {
  load(documentId: string): Promise<ReadonlyArray<SheetChange>>;
  add(documentId: string, change: SheetChange): void;
  /** Forgets a client's changes numbered up to `seq`. */
  forget(documentId: string, clientId: string, seq: number): void;
}
export interface SheetSyncOptions {
  documentId: string;
  push: (input: PushSheetInput) => Promise<PushSheetAnswer>;
  /** Replaceable in tests; the browser's EventSource otherwise. */
  connect?: (url: string) => SheetFeedSource;
  /** Replaceable in tests; a fresh random one otherwise. */
  clientId?: string;
  outbox?: SheetOutbox;
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
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

/** One step of this tab's history: the sheet as it showed before and after. */
interface Step {
  readonly before: SheetDoc;
  readonly after: SheetDoc;
}

const FRAME_TYPES = ["reset", "changes", "comments", "presence", "gone"] as const;
/** Edits inside this window travel as one push. */
const BATCH_MS = 60;
const MAX_BACKOFF_MS = 10_000;
const NO_MOMENT: SheetMoment = { now: 0, seed: 0 };
const HISTORY = 100;

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
  /**
   * Changes the server has acknowledged but the feed has not yet brought,
   * with the revision the server had reached. Shown until the feed gets
   * there, or an edit would vanish and come back between the two.
   */
  #landing: Array<{ readonly change: SheetChange; readonly revision: number }> = [];
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
  #undo: Step[] = [];
  #redo: Step[] = [];

  constructor(private readonly options: SheetSyncOptions) {
    this.clientId = options.clientId ?? crypto.randomUUID().slice(0, 18);
    this.#state = this.#snapshot();
    this.#connect();
    // Changes a reload or crash left unsent, by this tab or another, are sent again first.
    void options.outbox?.load(options.documentId).then((recovered) => {
      if (this.#destroyed) return;
      const mine = new Set(this.#pending.map((change) => `${change.clientId}:${change.seq}`));
      const missing = recovered.filter(
        (change) =>
          change.clientId !== this.clientId && !mine.has(`${change.clientId}:${change.seq}`),
      );
      if (!missing.length) return;
      this.#pending = [...missing, ...this.#pending];
      this.#rebuild();
      this.#schedule(0);
    });
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
    const step = this.#apply(ops);
    if (!step) return;
    this.#undo = [...this.#undo.slice(1 - HISTORY), step];
    this.#redo = [];
    this.#notify();
  }
  /**
   * Takes back this tab's last change, leaving anything someone else has
   * changed since; a step with nothing left to take back is skipped.
   */
  undo() {
    this.#travel(this.#undo, this.#redo);
  }
  redo() {
    this.#travel(this.#redo, this.#undo);
  }
  #travel(from: Step[], to: Step[]) {
    while (from.length && this.#view) {
      const step = from.pop()!;
      const applied = this.#apply(invertChange(step.before, step.after, this.#view));
      if (!applied) continue;
      to.push(applied);
      break;
    }
    this.#notify();
  }
  #apply(ops: readonly SheetOp[]): Step | null {
    if (!this.#confirmed || !this.#view || !ops.length || this.#status === "gone") return null;
    const before = this.#view;
    const change = { clientId: this.clientId, seq: ++this.#seq, ops };
    this.#pending.push(change);
    this.options.outbox?.add(this.options.documentId, change);
    this.#refused = null;
    this.#rebuild();
    this.#schedule(BATCH_MS);
    return { before, after: this.#view };
  }

  setCursor(cursor: SheetCursor | null) {
    this.#cursor = cursor;
    this.#cursorDirty = cursor !== null;
    if (cursor) this.#schedule(BATCH_MS);
  }

  pending = () => this.#pending.length > 0;
  /** Where this tab's selection is, as last set. */
  cursor = () => this.#cursor;

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
      canUndo: this.#undo.length > 0,
      canRedo: this.#redo.length > 0,
    };
  }
  #notify() {
    this.#state = this.#snapshot();
    for (const listener of this.#listeners) listener();
  }
  /** What the sheet shows: landing and unsent changes replayed over what the server confirmed. */
  #rebuild() {
    let view = this.#confirmed;
    if (view)
      for (const [index, change] of [
        ...this.#landing.map((each) => each.change),
        ...this.#pending,
      ].entries())
        view = applyChange(view, change, this.#revision + index + 1).doc;
    this.#view = view;
    this.#notify();
  }
  /**
   * Lets acknowledged changes go; ones the feed has yet to bring land until
   * `revision`. A refused one will never be in the feed, so it goes at once.
   */
  #acknowledge(clientId: string, seq: number, revision = 0, refused = new Set<number>()) {
    const before = this.#pending.length;
    const done = (change: SheetChange) => change.clientId === clientId && change.seq <= seq;
    const landed =
      revision > this.#revision
        ? this.#pending.filter((change) => done(change) && !refused.has(change.seq))
        : [];
    this.#landing = [
      ...this.#landing.filter((each) => !done(each.change)),
      ...landed.map((change) => ({ change, revision })),
    ];
    this.#pending = this.#pending.filter((change) => !done(change));
    if (clientId === this.clientId) this.#seq = Math.max(this.#seq, seq);
    if (before !== this.#pending.length)
      this.options.outbox?.forget(this.options.documentId, clientId, seq);
  }
  /**
   * Drops a client's unsent changes the server will never take. Later ones
   * would wait behind the gap forever, so they go too, and this tab numbers
   * its next change where the dropped ones began.
   */
  #reject(clientId: string, reason: string) {
    const dropped = this.#pending.filter((change) => change.clientId === clientId);
    if (!dropped.length) return;
    this.#pending = this.#pending.filter((change) => change.clientId !== clientId);
    const seqs = dropped.map((change) => change.seq);
    this.options.outbox?.forget(this.options.documentId, clientId, Math.max(...seqs));
    if (clientId === this.clientId) this.#seq = Math.min(...seqs) - 1;
    this.#refused = `Some changes weren’t kept: ${reason}.`;
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
    // One client's changes per push, in order: recovered ones first, then this tab's.
    const clientId = this.#pending[0]?.clientId ?? this.clientId;
    const run = this.#pending.findIndex((change) => change.clientId !== clientId);
    const changes = this.#pending.slice(
      0,
      Math.min(run === -1 ? this.#pending.length : run, SHEET_TRANSPORT.changes),
    );
    const cursor = this.#cursorDirty && clientId === this.clientId ? this.#cursor : null;
    if (cursor) this.#cursorDirty = false;
    this.#inflight = this.options
      .push({
        documentId: this.options.documentId,
        clientId,
        ...(changes.length ? { changes: changes.map((change) => JSON.stringify(change)) } : {}),
        ...(cursor ? { cursor } : {}),
      })
      .then(
        (result) => {
          this.#failures = 0;
          if ("rejected" in result) this.#reject(clientId, result.rejected);
          else {
            const refused = new Set(result.refused.map((each) => each.seq));
            this.#acknowledge(clientId, result.acked, result.revision, refused);
            if (result.refused.length)
              this.#refused = `Some changes weren’t kept: ${result.refused[0]!.reason}.`;
          }
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
        if (frame.acked !== null) this.#acknowledge(this.clientId, frame.acked);
        this.#landing = this.#landing.filter((each) => each.revision > frame.revision);
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
          this.#acknowledge(change.clientId, change.seq);
        }
        this.#confirmed = doc;
        this.#revision = Math.max(this.#revision, frame.revision);
        // Past the revision it was acknowledged at, a change the feed never brought was refused.
        this.#landing = this.#landing.filter((each) => each.revision > this.#revision);
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
