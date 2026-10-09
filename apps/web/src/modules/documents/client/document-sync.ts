import { Editor, Extension, type AnyExtension, type EditorOptions } from "@tiptap/core";
import { Node } from "@tiptap/pm/model";
import { EditorState, type Plugin, type Transaction } from "@tiptap/pm/state";
import { Mapping, ReplaceAroundStep, ReplaceStep, Step, Transform } from "@tiptap/pm/transform";
import { collab, getVersion, receiveTransaction, sendableSteps } from "prosemirror-collab";
import { isRemoteChange, SERVER_RESET } from "../editor/remote.ts";
import type {
  DocumentFrame,
  DocumentPresence,
  PushDocumentInput,
  PushDocumentResult,
} from "../schema.ts";
import type { OutboxStore } from "./outbox.ts";
import { presencePlugin, showCarets, type RemoteCaret } from "./presence.ts";

export type DocumentSyncStatus = "connecting" | "live" | "offline" | "gone";
/** The part of an EventSource the connection uses; tests stand in a fake. */
export interface DocumentFeedSource {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}
export interface DocumentSyncOptions {
  documentId: string;
  push: (input: PushDocumentInput) => Promise<PushDocumentResult>;
  /** The browser's editor extensions; the connection adds collaboration and cursors. */
  extensions: AnyExtension[];
  editorProps?: EditorOptions["editorProps"];
  /** Where unsent changes wait across reloads. */
  outbox: OutboxStore;
  /** Replaceable in tests; the browser's EventSource otherwise. */
  connect?: (url: string) => DocumentFeedSource;
  /** Shown beside this editor's cursor to everyone else; colours are CSS values. */
  user: DocumentPresence["user"];
}

/** Keystrokes inside this window travel as one batch. */
const BATCH_MS = 80;
/** A cursor moving on its own is sent at most this often. */
const CURSOR_MS = 250;
/** Unsent changes are written to the device at most this often. */
const SAVE_MS = 400;
const MAX_BACKOFF_MS = 10_000;
/** A batch the server keeps refusing is given up on after this many tries. */
const MAX_PUSH_FAILURES = 5;
/** Server steps kept to place cursors sent at an older revision. */
const STEP_LOG = 1_000;
/** The assistant's cursor stays this long after its last write. */
const ASSISTANT_IDLE_MS = 3_000;
const ASSISTANT = "model";
const assistantUser = {
  name: "Assistant",
  color: "var(--primary)",
  colorLight: "color-mix(in oklab, var(--primary) 15%, transparent)",
};

const frameTypes = ["reset", "steps", "presence", "gone"] as const;

interface Rebaseable {
  step: Step;
  inverted: Step;
}
/** prosemirror-collab keeps its unsent steps in plugin state it does not type. */
const unconfirmedOf = (plugin: Plugin | null, state: EditorState): Rebaseable[] =>
  (plugin?.getState(state) as { unconfirmed: Rebaseable[] } | undefined)?.unconfirmed ?? [];
/** The text a step would have written, for a person to place by hand. */
const insertedText = (step: Step) =>
  step instanceof ReplaceStep || step instanceof ReplaceAroundStep
    ? step.slice.content.textBetween(0, step.slice.content.size, "\n\n", " ").trim()
    : "";
/**
 * The unsent steps that will not survive rebasing over `over`, found the way
 * prosemirror-collab rebases: undo them, apply the server's, redo each mapped.
 */
const unplaceable = (doc: Node, unconfirmed: Rebaseable[], over: Step[]) => {
  const tr = new Transform(doc);
  for (let index = unconfirmed.length - 1; index >= 0; index--)
    tr.step(unconfirmed[index]!.inverted);
  for (const step of over) tr.step(step);
  // Mirroring is how collab's own rebase keeps a step and its undo paired; it is marked internal.
  const mapping = tr.mapping as Mapping & { setMirror(from: number, to: number): void };
  const lost: Step[] = [];
  let mapFrom = unconfirmed.length;
  for (const { step } of unconfirmed) {
    const mapped = step.map(tr.mapping.slice(mapFrom));
    mapFrom--;
    if (mapped && !tr.maybeStep(mapped).failed) mapping.setMirror(mapFrom, tr.steps.length - 1);
    else lost.push(step);
  }
  return lost;
};
const randomClient = () =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

/**
 * One document's live connection. It owns the editor (mounted into the panel
 * only while the panel shows it) so a closed panel can still send and rebase
 * its last changes. The server orders every step: local ones are sent on the
 * revision they were made on, and when someone else's land first the editor
 * rebases its own over them and sends again. Unsent steps are kept on the
 * device; any that can no longer be placed are handed to the person as text.
 */
export class DocumentSync {
  #editor: Editor | null = null;
  /** The collab plugin in the editor's state; replaced when the server resets the document. */
  #collab: Plugin | null = null;
  #clientId: string;
  #status: DocumentSyncStatus = "connecting";
  #error: string | null = null;
  /** The server's document at the editor's collab version, for saving unsent steps against. */
  #confirmed: Node | null = null;
  /**
   * The revision the server last said it stored this editor's steps up to.
   * Its echo can arrive before the push returns, so this is kept as a
   * revision, never a count of steps.
   */
  #storedRevision = 0;
  #recovered: string | null = null;
  #presenceDirty = false;
  #lastPresencePush = 0;
  #remote = new Map<string, DocumentPresence>();
  #assistantTimer: ReturnType<typeof setTimeout> | null = null;
  /** Scroll to the assistant's cursor once it is drawn, unless the person is typing here. */
  #reveal = false;
  #log: Step[] = [];
  #logStart = 0;
  #inflight: Promise<void> | null = null;
  #failures = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;
  #source: DocumentFeedSource | null = null;
  #destroyed = false;
  #listeners = new Set<() => void>();
  #version = 0;

  constructor(private readonly options: DocumentSyncOptions) {
    const saved = options.outbox.get(options.documentId);
    this.#clientId = saved?.clientId ?? randomClient();
    if (saved) this.#restore(saved);
    this.#connect();
  }

  /** Null until the first frame: the panel should not open on an empty document. */
  get editor() {
    return this.#editor;
  }
  get status() {
    return this.#status;
  }
  get error() {
    return this.#error;
  }
  /** Text from changes made offline that no longer fit anywhere, until dismissed. */
  get recovered() {
    return this.#recovered;
  }
  dismissRecovered() {
    this.#recovered = null;
    this.#notify();
  }
  /** Moves whenever anything a reader can see changed; for `useSyncExternalStore`. */
  get version() {
    return this.#version;
  }
  /** Leading unsent steps the server has stored but not yet sent back. */
  #storedAhead() {
    return this.#editor ? Math.max(0, this.#storedRevision - getVersion(this.#editor.state)) : 0;
  }
  /** Local changes the server has not stored yet. */
  pending() {
    return this.#editor
      ? unconfirmedOf(this.#collab, this.#editor.state).length > this.#storedAhead()
      : false;
  }
  setUser(user: DocumentPresence["user"]) {
    this.options.user = user;
    this.#presenceDirty = true;
    this.#schedule(BATCH_MS);
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
      if (!this.pending()) return true;
      if (this.#error && this.#failures >= MAX_PUSH_FAILURES) return false;
      // Refused as built on an older revision: wait for the steps that rebase it.
      // oxlint-disable-next-line eslint/no-await-in-loop -- The next round needs them.
      await this.#nextFrame();
    }
    return !this.pending();
  }

  destroy() {
    if (this.#destroyed) return;
    this.#save();
    this.#destroyed = true;
    for (const timer of [this.#timer, this.#saveTimer, this.#reconnectTimer, this.#assistantTimer])
      if (timer) clearTimeout(timer);
    this.#source?.close();
    this.#listeners.clear();
    this.#editor?.destroy();
  }

  #notify() {
    this.#version++;
    for (const listener of this.#listeners) listener();
  }
  #nextFrame() {
    return new Promise<void>((resolve) => {
      const done = this.subscribe(() => {
        done();
        resolve();
      });
      setTimeout(() => {
        done();
        resolve();
      }, MAX_BACKOFF_MS);
    });
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

  /** Documents and steps are read with the editor's own schema, built from its extensions. */
  #createEditor(doc: Record<string, unknown>, revision: number) {
    this.#collab = collab({ version: revision, clientID: this.#clientId });
    this.#editor = new Editor({
      element: document.createElement("div"),
      extensions: [
        ...this.options.extensions,
        Extension.create({
          name: "documentCollab",
          addProseMirrorPlugins: () => [this.#collab!, presencePlugin()],
        }),
      ],
      content: doc,
      ...(this.options.editorProps ? { editorProps: this.options.editorProps } : {}),
      onTransaction: ({ transaction }) => this.#local(transaction),
      onSelectionUpdate: () => {
        this.#presenceDirty = true;
        this.#schedule(Math.max(BATCH_MS, this.#lastPresencePush + CURSOR_MS - Date.now()));
      },
    });
    this.#confirmed = this.#editor.state.doc;
  }

  /** Reopens on what this device saved: its base document, then its unsent steps on top. */
  #restore(saved: NonNullable<ReturnType<OutboxStore["get"]>>) {
    try {
      this.#createEditor(saved.doc, saved.revision);
      const editor = this.#editor!;
      const steps = saved.steps.map((json) => Step.fromJSON(editor.schema, JSON.parse(json)));
      const tr = editor.state.tr.setMeta("addToHistory", false);
      for (const step of steps) tr.step(step);
      editor.view.dispatch(tr);
    } catch {
      // A saved entry from another schema or a damaged one: start from the server.
      this.#editor?.destroy();
      this.#editor = null;
      this.#confirmed = null;
      this.options.outbox.delete(this.options.documentId);
    }
  }

  #local(transaction: Transaction) {
    if (this.#destroyed || isRemoteChange(transaction) || !transaction.docChanged) return;
    this.#presenceDirty = true;
    this.#schedule(BATCH_MS);
    this.#scheduleSave();
    this.#notify();
  }

  #scheduleSave() {
    if (this.#saveTimer || this.#destroyed) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.#save();
    }, SAVE_MS);
  }
  #save() {
    const editor = this.#editor;
    if (this.#destroyed || !editor || !this.#confirmed) return;
    const unconfirmed = unconfirmedOf(this.#collab, editor.state);
    if (!unconfirmed.length) {
      this.options.outbox.delete(this.options.documentId);
      return;
    }
    this.options.outbox.set(this.options.documentId, {
      clientId: this.#clientId,
      revision: getVersion(editor.state),
      doc: this.#confirmed.toJSON() as Record<string, unknown>,
      steps: unconfirmed.map(({ step }) => JSON.stringify(step.toJSON())),
      savedAt: Date.now(),
    });
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
    const editor = this.#editor;
    if (!editor || this.#status !== "live") return Promise.resolve();
    const sendable = sendableSteps(editor.state);
    const steps = sendable && sendable.steps.length > this.#storedAhead() ? sendable.steps : null;
    if (!steps && !this.#presenceDirty) return Promise.resolve();
    const revision = getVersion(editor.state);
    const presence = this.#presenceDirty
      ? {
          anchor: editor.state.selection.anchor,
          head: editor.state.selection.head,
          // Positions are in the document as it reads once these steps are in.
          revision: revision + (steps?.length ?? 0),
          user: this.options.user,
        }
      : null;
    this.#presenceDirty = false;
    if (presence) this.#lastPresencePush = Date.now();
    const input: PushDocumentInput = {
      documentId: this.options.documentId,
      clientId: this.#clientId,
      revision,
      ...(steps ? { steps: steps.map((step) => JSON.stringify(step.toJSON())) } : {}),
      ...(presence ? { presence } : {}),
    };
    const flight = this.options.push(input).then(
      (result) => {
        this.#failures = 0;
        this.#setError(null);
        // Stored now, though they count as confirmed only once they come back.
        if (steps && !result.conflict)
          this.#storedRevision = Math.max(this.#storedRevision, result.revision);
      },
      (failure: unknown) => {
        this.#failures++;
        if (presence) this.#presenceDirty = true;
        this.#setError(
          failure instanceof Error && failure.message
            ? failure.message
            : "Could not save your changes.",
        );
        // The server may have dropped its copy of the document; a fresh feed
        // catches up from storage, and the unsent steps go again after it.
        this.#reconnect();
      },
    );
    this.#inflight = flight.finally(() => {
      this.#inflight = null;
      if (this.#failures >= MAX_PUSH_FAILURES) return;
      if (this.#presenceDirty || this.pending())
        this.#schedule(this.#failures ? this.#backoff(this.#failures) : BATCH_MS);
    });
    return this.#inflight;
  }

  #backoff(attempt: number) {
    return Math.min(MAX_BACKOFF_MS, 250 * 2 ** attempt);
  }

  #connect() {
    if (this.#destroyed) return;
    const params = new URLSearchParams({ client: this.#clientId });
    if (this.#editor) params.set("revision", String(getVersion(this.#editor.state)));
    const url = `/api/documents/${encodeURIComponent(this.options.documentId)}/stream?${params}`;
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

  #live() {
    this.#attempt = 0;
    this.#presenceDirty = true;
    this.#setStatus("live");
    this.#schedule(0);
  }

  #receive(frame: DocumentFrame) {
    switch (frame.type) {
      case "reset":
        this.#reset(frame.doc, frame.revision);
        this.#live();
        this.#notify();
        return;
      case "steps":
        this.#steps(frame);
        if (this.#status !== "live") this.#live();
        this.#notify();
        return;
      case "presence":
        if (frame.presence) this.#remote.set(frame.clientId, frame.presence);
        else this.#remote.delete(frame.clientId);
        this.#showCarets();
        return;
      case "gone":
        this.#source?.close();
        this.#source = null;
        this.options.outbox.delete(this.options.documentId);
        this.#setStatus("gone");
    }
  }

  /** The server's document wholesale; any unsent steps can no longer be rebased. */
  #reset(json: Record<string, unknown>, revision: number) {
    this.#log = [];
    this.#logStart = revision;
    this.#storedRevision = revision;
    const editor = this.#editor;
    if (!editor) {
      this.#createEditor(json, revision);
      return;
    }
    const doc = Node.fromJSON(editor.schema, json);
    this.#keepRecovered(unconfirmedOf(this.#collab, editor.state).map(({ step }) => step));
    const previous = this.#collab;
    this.#collab = collab({ version: revision, clientID: this.#clientId });
    const plugins = editor.state.plugins.map((plugin) =>
      plugin === previous ? this.#collab! : plugin,
    );
    editor.view.updateState(EditorState.create({ doc, plugins }));
    editor.view.dispatch(
      editor.state.tr.setMeta(SERVER_RESET, true).setMeta("addToHistory", false),
    );
    this.#confirmed = doc;
    this.options.outbox.delete(this.options.documentId);
  }

  #steps(frame: Extract<DocumentFrame, { type: "steps" }>) {
    const editor = this.#editor;
    if (!editor) return;
    const current = getVersion(editor.state);
    const start = frame.revision - frame.steps.length;
    // A gap means frames were missed; catch up from the server instead.
    if (start > current) {
      this.#reconnect();
      return;
    }
    const skip = current - start;
    const steps = frame.steps.slice(skip).map((json) => Step.fromJSON(editor.schema, json));
    const clientIds = frame.clientIds.slice(skip);
    if (!steps.length) return;
    let ours = 0;
    while (ours < clientIds.length && clientIds[ours] === this.#clientId) ours++;
    const unconfirmed = unconfirmedOf(this.#collab, editor.state).slice(ours);
    if (unconfirmed.length && steps.length > ours)
      this.#keepRecovered(unplaceable(editor.state.doc, unconfirmed, steps.slice(ours)));
    editor.view.dispatch(
      receiveTransaction(editor.state, steps, clientIds, { mapSelectionBackward: true }),
    );
    let confirmed = this.#confirmed!;
    for (const step of steps) confirmed = step.apply(confirmed).doc ?? confirmed;
    this.#confirmed = confirmed;
    this.#log.push(...steps);
    if (this.#log.length > STEP_LOG) {
      this.#logStart += this.#log.length - STEP_LOG;
      this.#log.splice(0, this.#log.length - STEP_LOG);
    }
    this.#scheduleSave();
    this.#followAssistant(steps, clientIds, frame.revision - steps.length);
    this.#showCarets();
    if (this.pending()) this.#schedule(BATCH_MS);
  }

  /**
   * Where the assistant just wrote, as a cursor of its own, so a reader sees
   * what it is changing; it fades once the assistant has paused.
   */
  #followAssistant(steps: Step[], clientIds: ReadonlyArray<string>, start: number) {
    let at: { revision: number; position: number } | null = null;
    steps.forEach((step, index) => {
      if (clientIds[index] !== ASSISTANT) return;
      step.getMap().forEach((_oldStart, _oldEnd, _newStart, newEnd) => {
        at = { revision: start + index + 1, position: newEnd };
      });
    });
    if (!at) return;
    const { revision, position } = at;
    this.#remote.set(ASSISTANT, {
      anchor: position,
      head: position,
      revision,
      user: assistantUser,
    });
    this.#reveal = true;
    if (this.#assistantTimer) clearTimeout(this.#assistantTimer);
    this.#assistantTimer = setTimeout(() => {
      this.#assistantTimer = null;
      this.#remote.delete(ASSISTANT);
      this.#showCarets();
    }, ASSISTANT_IDLE_MS);
  }

  #keepRecovered(steps: Step[]) {
    const text = steps.map(insertedText).filter(Boolean).join("\n\n");
    if (text) this.#recovered = this.#recovered ? `${this.#recovered}\n\n${text}` : text;
  }

  /** Every other cursor, mapped from the revision it was sent at onto this document. */
  #showCarets() {
    const editor = this.#editor;
    if (!editor) return;
    const version = getVersion(editor.state);
    const local = unconfirmedOf(this.#collab, editor.state);
    const carets: RemoteCaret[] = [];
    for (const [clientId, presence] of this.#remote) {
      if (clientId === this.#clientId) continue;
      if (presence.revision < this.#logStart || presence.revision > version) continue;
      const mapping = new Mapping(
        this.#log.slice(presence.revision - this.#logStart).map((step) => step.getMap()),
      );
      for (const { step } of local) mapping.appendMap(step.getMap());
      carets.push({
        clientId,
        anchor: mapping.map(presence.anchor),
        head: mapping.map(presence.head),
        user: presence.user,
      });
    }
    editor.view.dispatch(showCarets(editor.state, carets));
    if (!this.#reveal) return;
    this.#reveal = false;
    const view = editor.view;
    if (!view.dom.isConnected || view.dom.contains(document.activeElement)) return;
    const caret = view.dom.querySelector(`[data-caret-client="${ASSISTANT}"]`);
    const scroller = view.dom.closest(".overflow-y-auto");
    if (!caret || !scroller) return;
    const at = caret.getBoundingClientRect();
    const frame = scroller.getBoundingClientRect();
    // Only once it leaves the visible part, so following it never jitters.
    if (at.top >= frame.top && at.bottom <= frame.bottom) return;
    scroller.scrollTo?.({
      top: scroller.scrollTop + at.top - frame.top - frame.height / 3,
      behavior: "smooth",
    });
  }
}
