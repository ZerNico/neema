import { fromBase64, toBase64 } from "lib0/buffer";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import type { DocumentFrame, PushDocumentInput, PushDocumentResult } from "../schema.ts";
import { DOCUMENT_FIELD } from "../text.ts";

export type DocumentSyncStatus = "connecting" | "live" | "offline" | "gone";
export interface DocumentSyncOptions {
  documentId: string;
  push: (input: PushDocumentInput) => Promise<PushDocumentResult>;
  /** Replaceable in tests; the browser's EventSource otherwise. */
  connect?: (url: string) => EventSource;
  /** Shown beside this editor's cursor to everyone else; colours are CSS values. */
  user: { name: string; color: string; colorLight: string };
}

/** Changes applied from the server; they are never sent back. */
const REMOTE = Symbol("remote");
/** Keystrokes inside this window travel as one batch. */
const BATCH_MS = 80;
/** A cursor moving on its own is sent at most this often. */
const CURSOR_MS = 250;
const MAX_BACKOFF_MS = 10_000;
/** A batch the server keeps refusing is given up on after this many tries. */
const MAX_PUSH_FAILURES = 5;

const frameTypes = ["sync", "update", "awareness", "gone"] as const;

/**
 * One document's live connection: a Y.Doc kept in step with the server over
 * a stream down and batched pushes up. Every local change waits in the outbox
 * until the server acknowledges it; a resend is harmless because Yjs updates
 * are idempotent, so the outbox never needs sequence numbers.
 */
export class DocumentSync {
  readonly doc = new Y.Doc();
  /** The document's tree, as the editor binds it. */
  readonly fragment = this.doc.getXmlFragment(DOCUMENT_FIELD);
  readonly awareness = new Awareness(this.doc);
  #status: DocumentSyncStatus = "connecting";
  #error: string | null = null;
  #revision = 0;
  #synced = false;
  #outbox: Uint8Array[] = [];
  #cursorDirty = false;
  #lastCursorPush = 0;
  #inflight: Promise<void> | null = null;
  #failures = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;
  #source: EventSource | null = null;
  #destroyed = false;
  #listeners = new Set<() => void>();
  #version = 0;

  constructor(private readonly options: DocumentSyncOptions) {
    this.awareness.setLocalStateField("user", options.user);
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return;
      this.#outbox.push(update);
      this.#schedule(BATCH_MS);
    });
    this.awareness.on(
      "update",
      (
        { added, updated, removed }: Record<"added" | "updated" | "removed", number[]>,
        origin: unknown,
      ) => {
        if (origin === REMOTE) return;
        const own = this.doc.clientID;
        if (![...added, ...updated, ...removed].includes(own)) return;
        this.#cursorDirty = true;
        this.#schedule(Math.max(BATCH_MS, this.#lastCursorPush + CURSOR_MS - Date.now()));
      },
    );
    this.fragment.observeDeep(() => this.#notify());
    this.#connect();
  }

  get status() {
    return this.#status;
  }
  /** False until the first `sync` frame: the editor should not open on an empty doc. */
  get synced() {
    return this.#synced;
  }
  get revision() {
    return this.#revision;
  }
  get error() {
    return this.#error;
  }
  /** Moves whenever anything a reader can see changed; for `useSyncExternalStore`. */
  get version() {
    return this.#version;
  }
  /** Local changes the server has not acknowledged yet. */
  pending() {
    return this.#outbox.length > 0 || this.#inflight !== null;
  }
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Resolves once every local change so far is stored, or false when that failed. */
  async flush(): Promise<boolean> {
    for (let round = 0; round <= MAX_PUSH_FAILURES; round++) {
      if (this.#timer) {
        clearTimeout(this.#timer);
        this.#timer = null;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each round waits on the push before it.
      await (this.#inflight ?? this.#send());
      if (!this.#outbox.length && !this.#inflight) return true;
      if (this.#error && this.#failures >= MAX_PUSH_FAILURES) return false;
    }
    return !this.pending();
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#source?.close();
    this.#listeners.clear();
    this.awareness.destroy();
    this.doc.destroy();
  }

  #notify() {
    this.#version++;
    for (const listener of this.#listeners) listener();
  }
  #setStatus(status: DocumentSyncStatus) {
    if (this.#status === status) return;
    this.#status = status;
    this.#notify();
  }
  #setError(error: string | null) {
    if (this.#error === error) return;
    this.#error = error;
    this.#notify();
  }

  #schedule(delay: number) {
    if (this.#destroyed || this.#timer || this.#inflight) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#send();
    }, delay);
  }

  #send(): Promise<void> {
    if (this.#destroyed || this.#inflight) return this.#inflight ?? Promise.resolve();
    if (!this.#outbox.length && !this.#cursorDirty) return Promise.resolve();
    // The editor opens only on synced text, so before that there is nothing of
    // the person's to send, only the server's own cursor echo.
    if (!this.#synced) return Promise.resolve();
    const batch = this.#outbox.length ? Y.mergeUpdates(this.#outbox) : null;
    const taken = this.#outbox.length;
    const cursor = this.#cursorDirty;
    this.#cursorDirty = false;
    if (cursor) this.#lastCursorPush = Date.now();
    const input: PushDocumentInput = {
      documentId: this.options.documentId,
      clientId: this.doc.clientID,
      ...(batch ? { update: toBase64(batch) } : {}),
      ...(cursor
        ? { awareness: toBase64(encodeAwarenessUpdate(this.awareness, [this.doc.clientID])) }
        : {}),
    };
    const flight = this.options.push(input).then(
      (result) => {
        this.#outbox.splice(0, taken);
        this.#failures = 0;
        this.#revision = Math.max(this.#revision, result.revision);
        this.#setError(null);
      },
      (failure: unknown) => {
        this.#failures++;
        if (cursor) this.#cursorDirty = true;
        this.#setError(
          failure instanceof Error && failure.message
            ? failure.message
            : "Could not save your changes.",
        );
        // The server may have dropped its copy of the document; a fresh feed
        // starts from storage, and the outbox is sent again after it.
        this.#reconnect();
      },
    );
    // Pushes going out and coming back are no news to a reader: only what they
    // can see (text, status, error) re-renders them.
    this.#inflight = flight.finally(() => {
      this.#inflight = null;
      if (this.#failures < MAX_PUSH_FAILURES && (this.#outbox.length || this.#cursorDirty))
        this.#schedule(this.#failures ? this.#backoff(this.#failures) : BATCH_MS);
    });
    return this.#inflight;
  }

  #backoff(attempt: number) {
    return Math.min(MAX_BACKOFF_MS, 250 * 2 ** attempt);
  }

  #connect() {
    if (this.#destroyed) return;
    const stateVector = encodeURIComponent(toBase64(Y.encodeStateVector(this.doc)));
    const url = `/api/documents/${encodeURIComponent(this.options.documentId)}/stream?client=${this.doc.clientID}&sv=${stateVector}`;
    const source = (this.options.connect ?? ((href) => new EventSource(href)))(url);
    this.#source = source;
    const handle = (event: MessageEvent<string>) => {
      if (this.#source !== source) return;
      this.#receive(JSON.parse(event.data) as DocumentFrame);
    };
    for (const type of frameTypes) source.addEventListener(type, handle);
    source.addEventListener("error", () => {
      if (this.#source !== source || this.#status === "gone") return;
      this.#reconnect();
    });
  }

  #reconnect() {
    if (this.#destroyed || this.#status === "gone" || this.#reconnectTimer) return;
    this.#source?.close();
    this.#source = null;
    this.#setStatus("offline");
    this.#attempt++;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, this.#backoff(this.#attempt));
  }

  #receive(frame: DocumentFrame) {
    switch (frame.type) {
      case "sync": {
        Y.applyUpdate(this.doc, fromBase64(frame.update), REMOTE);
        if (frame.awareness)
          applyAwarenessUpdate(this.awareness, fromBase64(frame.awareness), REMOTE);
        // The outbox survives reconnects and only an acknowledgement empties
        // it, so whatever was typed while offline is still queued here.
        this.#revision = frame.revision;
        this.#synced = true;
        this.#attempt = 0;
        this.#cursorDirty = true;
        this.#setStatus("live");
        this.#schedule(0);
        this.#notify();
        return;
      }
      case "update":
        Y.applyUpdate(this.doc, fromBase64(frame.update), REMOTE);
        this.#revision = Math.max(this.#revision, frame.revision);
        return;
      case "awareness":
        applyAwarenessUpdate(this.awareness, fromBase64(frame.update), REMOTE);
        return;
      case "gone":
        this.#source?.close();
        this.#source = null;
        this.#outbox = [];
        this.#setStatus("gone");
    }
  }
}
