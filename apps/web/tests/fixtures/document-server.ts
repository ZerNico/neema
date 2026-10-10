import type { Node } from "@tiptap/pm/model";
import { clearDeviceCaches, setDeviceCacheOwner } from "~/modules/cache/client/device-cache.ts";
import { Step, Transform } from "@tiptap/pm/transform";
import { ensureIds } from "~/modules/documents/editor/block-ids.ts";
import {
  documentSchema,
  parseMarkdown,
  replaceDifference,
  toMarkdown,
} from "~/modules/documents/editor/markdown.ts";
import type {
  DocumentFrame,
  DocumentPresence,
  EditableDocument,
  PushDocumentInput,
  PushDocumentResult,
} from "~/modules/documents/schema.ts";

/** A stored row as tests write it: the row, and its text as Markdown. */
export type SeedDocument = Omit<EditableDocument, "kind"> & {
  content: string;
  kind?: EditableDocument["kind"];
};

/**
 * A signed-in device with nothing saved: the app sets the cache owner before
 * anything renders, and an editor's unsent changes must not carry over
 * from one test to the next.
 */
export async function freshDocumentDevice() {
  await clearDeviceCaches();
  setDeviceCacheOwner("tester");
}

/**
 * The server half of live documents for jsdom tests: a real ProseMirror
 * document per id that orders steps like the server, fed by the mocked
 * `pushDocument` and read through a fake EventSource, so merges in these
 * tests are real rebases rather than stubs.
 */
export function fakeDocumentServer() {
  const documents = new Map<
    string,
    {
      doc: Node;
      row: EditableDocument;
      steps: { json: Record<string, unknown>; clientId: string }[];
      feeds: Set<FakeEventSource>;
    }
  >();
  const pushes: PushDocumentInput[] = [];
  let hold: Promise<void> | null = null;

  const entry = (documentId: string) => {
    const found = documents.get(documentId);
    if (!found) throw new Error(`no fake document ${documentId}`);
    return found;
  };
  const commit = (documentId: string, steps: Step[], clientId: string, by: "user" | "model") => {
    const found = entry(documentId);
    for (const step of steps) {
      found.doc = step.apply(found.doc).doc!;
      found.steps.push({ json: step.toJSON() as Record<string, unknown>, clientId });
    }
    found.row = {
      ...found.row,
      revision: found.steps.length,
      lastEditedBy: by,
    };
    const frame: DocumentFrame = {
      type: "steps",
      steps: steps.map((step) => step.toJSON() as Record<string, unknown>),
      clientIds: steps.map(() => clientId),
      revision: found.row.revision,
    };
    for (const feed of found.feeds) feed.emit(frame);
  };

  class FakeEventSource {
    readonly documentId: string;
    readonly clientId: string | null;
    #listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();
    #closed = false;
    constructor(url: string) {
      const parsed = new URL(url, "http://test");
      this.documentId = decodeURIComponent(parsed.pathname.split("/")[3]!);
      this.clientId = parsed.searchParams.get("client");
      const from = parsed.searchParams.get("revision");
      queueMicrotask(() => {
        if (this.#closed) return;
        const found = documents.get(this.documentId);
        if (!found) return this.emit({ type: "gone" });
        found.feeds.add(this);
        const revision = from === null ? null : Number(from);
        this.emit(
          revision !== null && revision <= found.steps.length
            ? {
                type: "steps",
                steps: found.steps.slice(revision).map((step) => step.json),
                clientIds: found.steps.slice(revision).map((step) => step.clientId),
                revision: found.steps.length,
              }
            : {
                type: "reset",
                doc: found.doc.toJSON() as Record<string, unknown>,
                revision: found.steps.length,
              },
        );
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
    seed({ content, ...row }: SeedDocument) {
      const doc = ensureIds(new Transform(parseMarkdown(content))).doc;
      documents.set(row.id, {
        doc,
        row: { kind: "text", ...row, revision: 0 },
        steps: [],
        feeds: new Set(),
      });
    },
    /** The stored row, as `getDocument` would return it. */
    row: (documentId: string) => documents.get(documentId)?.row ?? null,
    content: (documentId: string) => toMarkdown(entry(documentId).doc),
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
      change: (markdown: string) => string,
      by: "user" | "model" = "model",
    ) {
      const found = entry(documentId);
      const tr = ensureIds(
        replaceDifference(new Transform(found.doc), parseMarkdown(change(toMarkdown(found.doc)))),
      );
      commit(documentId, tr.steps, by === "model" ? "model" : "elsewhere", by);
    },
    /** Another editor's cursor, sent to every open editor as is: possibly ahead of its steps. */
    presence(documentId: string, clientId: string, presence: DocumentPresence) {
      for (const feed of entry(documentId).feeds)
        feed.emit({ type: "presence", clientId, presence });
    },
    push: async ({ data }: { data: PushDocumentInput }): Promise<PushDocumentResult> => {
      pushes.push(data);
      if (hold) await hold;
      const found = entry(data.documentId);
      if (!data.steps) return { revision: found.steps.length, conflict: false };
      if (data.revision !== found.steps.length)
        return { revision: found.steps.length, conflict: true };
      commit(
        data.documentId,
        data.steps.map((json) => Step.fromJSON(documentSchema, JSON.parse(json))),
        data.clientId,
        "user",
      );
      return { revision: found.steps.length, conflict: false };
    },
  };
}
