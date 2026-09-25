import { fromBase64, toBase64 } from "lib0/buffer";
import { simpleDiffString } from "lib0/diff";
import { useEffect, useState } from "react";
import * as Y from "yjs";
import type { DocumentSync } from "~/modules/documents/client/document-sync.ts";
import type {
  EditableDocument,
  DocumentFrame,
  PushDocumentInput,
} from "~/modules/documents/schema.ts";
import { DOCUMENT_TEXT } from "~/modules/documents/text.ts";

/**
 * The server half of live documents for jsdom tests: a real Y.Doc per
 * document, fed by the mocked `pushDocument` and read through a fake
 * EventSource, so merges in these tests are Yjs merges rather than stubs.
 */
export function fakeDocumentServer() {
  const documents = new Map<
    string,
    { doc: Y.Doc; row: EditableDocument; feeds: Set<FakeEventSource> }
  >();
  const pushes: PushDocumentInput[] = [];
  let hold: Promise<void> | null = null;

  const entry = (documentId: string) => {
    const found = documents.get(documentId);
    if (!found) throw new Error(`no fake document ${documentId}`);
    return found;
  };
  const broadcast = (documentId: string, frame: DocumentFrame, except: number | null) => {
    for (const feed of entry(documentId).feeds) if (feed.clientId !== except) feed.emit(frame);
  };
  const commit = (
    documentId: string,
    update: Uint8Array,
    clientId: number | null,
    by: "user" | "model",
  ) => {
    const found = entry(documentId);
    found.row = {
      ...found.row,
      content: found.doc.getText(DOCUMENT_TEXT).toString(),
      revision: found.row.revision + 1,
      lastEditedBy: by,
    };
    broadcast(
      documentId,
      { type: "update", update: toBase64(update), revision: found.row.revision, clientId },
      clientId,
    );
  };

  class FakeEventSource {
    readonly documentId: string;
    readonly clientId: number | null;
    #listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();
    #closed = false;
    constructor(url: string) {
      const parsed = new URL(url, "http://test");
      this.documentId = decodeURIComponent(parsed.pathname.split("/")[3]!);
      const client = parsed.searchParams.get("client");
      this.clientId = client === null ? null : Number(client);
      const stateVector = parsed.searchParams.get("sv");
      queueMicrotask(() => {
        if (this.#closed) return;
        const found = documents.get(this.documentId);
        if (!found) return this.emit({ type: "gone" });
        found.feeds.add(this);
        this.emit({
          type: "sync",
          update: toBase64(
            Y.encodeStateAsUpdate(found.doc, stateVector ? fromBase64(stateVector) : undefined),
          ),
          awareness: null,
          revision: found.row.revision,
        });
      });
    }
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
      const set = this.#listeners.get(type) ?? new Set();
      set.add(listener);
      this.#listeners.set(type, set);
    }
    removeEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
      this.#listeners.get(type)?.delete(listener);
    }
    emit(frame: DocumentFrame) {
      if (this.#closed) return;
      const event = new MessageEvent(frame.type, { data: JSON.stringify(frame) });
      for (const listener of this.#listeners.get(frame.type) ?? []) listener(event);
    }
    close() {
      this.#closed = true;
      documents.get(this.documentId)?.feeds.delete(this);
    }
  }

  return {
    EventSource: FakeEventSource,
    pushes,
    seed(row: EditableDocument) {
      const doc = new Y.Doc();
      doc.getText(DOCUMENT_TEXT).insert(0, row.content);
      documents.set(row.id, { doc, row, feeds: new Set() });
    },
    /** The stored row, as `getDocument` would return it. */
    row: (documentId: string) => documents.get(documentId)?.row ?? null,
    content: (documentId: string) => entry(documentId).doc.getText(DOCUMENT_TEXT).toString(),
    remove(documentId: string) {
      const found = documents.get(documentId);
      documents.delete(documentId);
      for (const feed of found?.feeds ?? []) feed.emit({ type: "gone" });
    },
    /** Holds every push until the returned release runs. */
    holdPushes() {
      let release!: () => void;
      hold = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        hold = null;
        release();
      };
    },
    /** An edit made elsewhere (the assistant, another tab), sent to every open editor. */
    editElsewhere(
      documentId: string,
      change: (text: Y.Text) => void,
      by: "user" | "model" = "model",
    ) {
      const found = entry(documentId);
      const updates: Uint8Array[] = [];
      const collect = (update: Uint8Array) => updates.push(update);
      found.doc.on("update", collect);
      change(found.doc.getText(DOCUMENT_TEXT));
      found.doc.off("update", collect);
      commit(documentId, Y.mergeUpdates(updates), null, by);
    },
    push: async ({ data }: { data: PushDocumentInput }) => {
      pushes.push(data);
      if (hold) await hold;
      const found = entry(data.documentId);
      if (data.update) {
        Y.applyUpdate(found.doc, fromBase64(data.update));
        commit(data.documentId, fromBase64(data.update), data.clientId, "user");
      }
      return { revision: found.row.revision };
    },
  };
}

/**
 * Stands in for the CodeMirror editor: a textarea that turns each change into
 * the smallest Y.Text edit, which is what the Yjs binding does.
 */
export function FakeSourceEditor({ sync }: { sync: DocumentSync }) {
  const [value, setValue] = useState(() => sync.text.toString());
  useEffect(() => {
    const observe = () => setValue(sync.text.toString());
    sync.text.observe(observe);
    return () => sync.text.unobserve(observe);
  }, [sync]);
  return (
    <textarea
      aria-label="Document source"
      value={value}
      onChange={(event) => {
        const change = simpleDiffString(sync.text.toString(), event.target.value);
        sync.doc.transact(() => {
          if (change.remove) sync.text.delete(change.index, change.remove);
          if (change.insert) sync.text.insert(change.index, change.insert);
        });
      }}
    />
  );
}
