import { Effect, Schema } from "effect";
import { Response as AiResponse } from "effect/unstable/ai";
import { describe, expect, it } from "vitest";
import type { EditableDocument } from "../schema.ts";
import {
  FOCUS_CHARS,
  FOCUS_LINES,
  prepareDocumentTools,
  type DocumentToolService,
} from "./document-tools.ts";

const CONVERSATION = "conv-1";
let nextId = 0;
const countOccurrences = (haystack: string, needle: string) => {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count++;
  return count;
};
function fakeService(initial: EditableDocument[] = []) {
  nextId = 0;
  const rows = new Map(initial.map((document) => [document.id, document]));
  const stamp = new Date(0).toISOString();
  const service: DocumentToolService = {
    list: () => Effect.sync(() => [...rows.values()]),
    beginLive: () => Effect.succeed(null),
    updateLive: () => Effect.succeed(false),
    finishLive: () => Effect.succeed(null),
    create: (_userId, input) =>
      Effect.sync(() => {
        const document: EditableDocument = {
          id: `doc-${++nextId}`,
          conversationId: input.conversationId ?? null,
          projectId: input.projectId ?? null,
          canEdit: true,
          title: input.title,
          content: input.content,
          revision: 1,
          lastEditedBy: "model",
          createdAt: stamp,
          updatedAt: stamp,
        };
        rows.set(document.id, document);
        return { outcome: "created" as const, document };
      }),
    edit: (_userId, input) =>
      Effect.sync(() => {
        const document = rows.get(input.documentId)!;
        const staleRead =
          input.expectedRevision !== undefined && input.expectedRevision !== document.revision;
        const count = countOccurrences(document.content, input.old);
        if (count === 0)
          return {
            outcome: "no_match" as const,
            document,
            preview: document.content.split("\n").slice(0, 2).join("\n"),
            staleRead,
          };
        if (count > 1) return { outcome: "ambiguous" as const, document, count, staleRead };
        const next = {
          ...document,
          content: document.content.replace(input.old, () => input.new),
          revision: document.revision + 1,
          lastEditedBy: "model" as const,
        };
        rows.set(next.id, next);
        return { outcome: "updated" as const, document: next, staleRead };
      }),
    replace: (_userId, input) =>
      Effect.sync(() => {
        const document = rows.get(input.documentId)!;
        if (document.revision !== input.expectedRevision)
          return { outcome: "conflict" as const, document };
        const next = {
          ...document,
          content: input.content,
          revision: document.revision + 1,
          lastEditedBy: "model" as const,
        };
        rows.set(next.id, next);
        return { outcome: "updated" as const, document: next };
      }),
  };
  /** What the person's editor or a tick does: a user-attributed revision bump. */
  const userWrite = (documentId: string, content: string) => {
    const document = rows.get(documentId)!;
    rows.set(documentId, {
      ...document,
      content,
      revision: document.revision + 1,
      lastEditedBy: "user",
    });
  };
  return { service, rows, userWrite };
}
const prepare = (service: DocumentToolService, openDocumentId?: string) =>
  Effect.runPromise(
    prepareDocumentTools({
      service,
      userId: "user",
      conversationId: CONVERSATION,
      messageId: "message-1",
      openDocumentId,
      writeGuard: () => Effect.void,
    }),
  );
const data = (messages: ReadonlyArray<{ role: string; content: unknown }>) => {
  const message = messages.find((candidate) => candidate.role === "assistant")!;
  return JSON.parse(String(message.content).split("\n").slice(1).join("\n")) as {
    focused: {
      id: string;
      title: string;
      revision: number;
      lastEditedBy: string;
      editedSinceYourLastWrite: boolean;
      content: string;
      truncated?: true;
      window?: {
        fromLine: number;
        fromCharacter?: number;
        toLine: number;
        totalLines: number;
        next?: { fromLine: number; fromCharacter?: number };
      };
      chars: number;
    } | null;
    others: Array<{ id: string; title: string; chars: number; editedSinceYourLastWrite: boolean }>;
  };
};

describe("document tools parameter transport", () => {
  it.each([
    ["create_document", { title: "Checklist" }],
    ["edit_document", { old: "before" }],
    ["replace_document", { documentId: "doc-1", content: "after" }],
  ] as const)(
    "accepts a %s call with omitted required keys for the handler to correct",
    async (name, params) => {
      const { service } = fakeService();
      const tools = await prepare(service);
      const decoded = await Effect.runPromise(
        Schema.decodeUnknownEffect(AiResponse.StreamPart(tools.group.toolkit))({
          type: "tool-call",
          id: "tool-1",
          name,
          params,
          providerExecuted: false,
        }),
      );
      expect(decoded).toMatchObject({ type: "tool-call", name, params });
    },
  );
});

describe("document tools trailing data", () => {
  it("sends nothing until a document exists, then the policy and the manifest", async () => {
    const { service } = fakeService();
    const tools = await prepare(service);
    expect(tools.messages()).toEqual([]);
    const created = await Effect.runPromise(
      tools.group.handlers.create_document({ title: "Plan", content: "# Plan\n- [ ] one" }),
    );
    expect(created).toMatchObject({ outcome: "created", title: "Plan", revision: 1 });
    expect(JSON.stringify(created)).not.toContain("# Plan");
    const messages = tools.messages();
    // Never system role: a hoisting provider would fold it into the cached system block.
    expect(messages[0]).toMatchObject({ role: "user" });
    expect(String(messages[0]!.content)).toContain("DATA TO EDIT");
    expect(data(messages)).toEqual({
      focused: {
        id: "doc-1",
        title: "Plan",
        revision: 1,
        lastEditedBy: "model",
        editedSinceYourLastWrite: false,
        chars: 16,
        content: "# Plan\n- [ ] one",
      },
      others: [],
    });
  });
  it("focuses the document the model last touched, or the one the person has open", async () => {
    const { service } = fakeService();
    const tools = await prepare(service);
    await Effect.runPromise(tools.group.handlers.create_document({ title: "A", content: "aaa" }));
    await Effect.runPromise(tools.group.handlers.create_document({ title: "B", content: "bbb" }));
    expect(data(tools.messages()).focused?.title).toBe("B");
    expect(data(tools.messages()).others.map((other) => other.title)).toEqual(["A"]);
    // Summaries never carry content.
    expect(JSON.stringify(data(tools.messages()).others)).not.toContain("aaa");
    await Effect.runPromise(tools.group.handlers.read_chat_document({ documentId: "doc-1" }));
    expect(data(tools.messages()).focused?.title).toBe("A");
    // A second session starts on the open document, then an explicit read wins.
    const pinned = await prepare(service, "doc-1");
    expect(data(pinned.messages()).focused?.title).toBe("A");
    await Effect.runPromise(pinned.group.handlers.read_chat_document({ documentId: "doc-2" }));
    expect(data(pinned.messages()).focused?.title).toBe("B");
    // Newest by default when nothing was touched yet.
    const fresh = await prepare(service);
    expect(data(fresh.messages()).focused?.title).toBe("B");
  });
  it("flags a person's edit since the model last saw the document", async () => {
    const { service, userWrite } = fakeService();
    const tools = await prepare(service);
    await Effect.runPromise(
      tools.group.handlers.create_document({ title: "List", content: "- [ ] a\n- [ ] b" }),
    );
    expect(data(tools.messages()).focused?.editedSinceYourLastWrite).toBe(false);
    userWrite("doc-1", "- [x] a\n- [ ] b");
    await Effect.runPromise(tools.refresh());
    expect(data(tools.messages()).focused).toMatchObject({
      revision: 2,
      lastEditedBy: "user",
      editedSinceYourLastWrite: true,
      content: "- [x] a\n- [ ] b",
    });
    // Reading or editing it catches the model up.
    const edited = await Effect.runPromise(
      tools.group.handlers.edit_document({ old: "- [ ] b", new: "- [ ] b!", expectedRevision: 1 }),
    );
    expect(edited).toMatchObject({ outcome: "updated", revision: 3, staleRead: true });
    expect(data(tools.messages()).focused?.editedSinceYourLastWrite).toBe(false);
  });
  it("says when a read adds nothing, but not when it moves the window or catches up", async () => {
    const { service, userWrite } = fakeService();
    const tools = await prepare(service);
    await Effect.runPromise(
      tools.group.handlers.create_document({ title: "Plan", content: "a\nb\nc" }),
    );
    // Creating already focused it, so the first read is the redundant one.
    const repeat = await Effect.runPromise(tools.group.handlers.read_chat_document({}));
    expect(repeat).toMatchObject({ outcome: "read", revision: 1 });
    expect(repeat.message).toContain("Already focused at revision 1");

    // Moving the window is the one reason to ask again.
    const moved = await Effect.runPromise(tools.group.handlers.read_chat_document({ fromLine: 1 }));
    expect(moved.message).toBeUndefined();

    // So is catching up with the person.
    userWrite("doc-1", "a\nb\nc\nd");
    const caughtUp = await Effect.runPromise(tools.group.handlers.read_chat_document({}));
    expect(caughtUp).toMatchObject({ outcome: "read", revision: 2 });
    expect(caughtUp.message).toBeUndefined();
  });
  it("windows a long document instead of sending it whole", async () => {
    const { service } = fakeService();
    const tools = await prepare(service);
    const lines = Array.from({ length: 600 }, (_, index) => `line ${index} ${"x".repeat(60)}`);
    await Effect.runPromise(
      tools.group.handlers.create_document({ title: "Long", content: lines.join("\n") }),
    );
    const focused = data(tools.messages()).focused!;
    expect(focused.truncated).toBe(true);
    expect(focused.window).toEqual({
      fromLine: 0,
      toLine: FOCUS_LINES,
      totalLines: 600,
      next: { fromLine: FOCUS_LINES },
    });
    expect(focused.content.split("\n")).toHaveLength(FOCUS_LINES);
    expect(focused.content.length).toBeLessThanOrEqual(FOCUS_CHARS);
    expect(focused.content).not.toContain("line 599");
    await Effect.runPromise(tools.group.handlers.read_chat_document({ fromLine: "500" }));
    const moved = data(tools.messages()).focused!;
    expect(moved.window).toEqual({ fromLine: 500, toLine: 600, totalLines: 600 });
    expect(moved.content).toContain("line 599");
  });
  it("enforces both focus bounds and continues through an oversized line without gaps", async () => {
    const { service } = fakeService();
    const tools = await prepare(service);
    const shortLines = Array.from({ length: FOCUS_LINES + 1 }, (_, index) => `line ${index}`);
    await Effect.runPromise(
      tools.group.handlers.create_document({ title: "Many lines", content: shortLines.join("\n") }),
    );
    const bounded = data(tools.messages()).focused!;
    expect(bounded.content.split("\n")).toHaveLength(FOCUS_LINES);
    expect(bounded.window?.next).toEqual({ fromLine: FOCUS_LINES });

    const longLine = "x".repeat(FOCUS_CHARS + 100);
    await Effect.runPromise(
      tools.group.handlers.create_document({ title: "Long line", content: longLine }),
    );
    const first = data(tools.messages()).focused!;
    expect(first.content).toBe(longLine.slice(0, FOCUS_CHARS));
    expect(first.window?.next).toEqual({ fromLine: 0, fromCharacter: FOCUS_CHARS });
    await Effect.runPromise(
      tools.group.handlers.read_chat_document({
        documentId: "doc-2",
        fromLine: 0,
        fromCharacter: FOCUS_CHARS,
      }),
    );
    expect(data(tools.messages()).focused?.content).toBe(longLine.slice(FOCUS_CHARS));
  });
  it("explains no_match and ambiguous anchors and requires an id among several", async () => {
    const { service } = fakeService();
    const tools = await prepare(service);
    await Effect.runPromise(
      tools.group.handlers.create_document({ title: "One", content: "same\nsame\nother" }),
    );
    expect(
      await Effect.runPromise(tools.group.handlers.edit_document({ old: "same", new: "x" })),
    ).toMatchObject({ outcome: "ambiguous", count: 2 });
    const missing = await Effect.runPromise(
      tools.group.handlers.edit_document({ old_string: "absent", new_string: "x" }),
    );
    expect(missing).toMatchObject({ outcome: "no_match", preview: "same\nsame" });
    await Effect.runPromise(tools.group.handlers.create_document({ title: "Two", content: "b" }));
    const unaddressed = await Effect.runPromise(
      tools.group.handlers.edit_document({ old: "same", new: "x" }),
    );
    expect(unaddressed).toMatchObject({ outcome: "invalid" });
    expect(unaddressed.message).toContain("documentId is required");
    expect(unaddressed.message).toContain("One");
    expect(unaddressed.message).toContain("Two");
    expect(await Effect.runPromise(tools.group.handlers.read_chat_document({}))).toMatchObject({
      outcome: "listed",
      documents: [{ title: "One" }, { title: "Two" }],
    });
    expect(
      await Effect.runPromise(tools.group.handlers.edit_document({ old: "", new: "x" })),
    ).toMatchObject({ outcome: "invalid" });
    // A missing key reaches the handler as a correction rather than failing the
    // provider stream during parameter decoding.
    const incomplete = await Effect.runPromise(
      tools.group.handlers.create_document({ title: "No body" }),
    );
    expect(incomplete).toMatchObject({ outcome: "invalid" });
    expect(incomplete.message).toContain("Provide a title and markdown content.");
  });
});
