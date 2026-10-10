import type { Node } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { Effect, Schema } from "effect";
import { Response as AiResponse } from "effect/unstable/ai";
import { describe, expect, it } from "vitest";
import { blockIdOf, ensureIds } from "../editor/block-ids.ts";
import {
  documentSchema,
  parseMarkdown,
  replaceDifference,
  toMarkdown,
} from "../editor/markdown.ts";
import { applyTreeEdit } from "../editor/tree-edit.ts";
import type { EditableDocument } from "../schema.ts";
import { FOCUS_CHARS, prepareDocumentTools, type DocumentToolService } from "./document-tools.ts";

const CONVERSATION = "conv-1";
const stamp = new Date(0).toISOString();
let counter = 0;
const mint = () => `b${++counter}`;

/**
 * The service as the tools use it, in memory but on the real tree: documents
 * are ProseMirror trees with IDs, edits go through the real edit layer.
 */
function fakeService(initial: { id: string; title: string; content: string }[] = []) {
  counter = 0;
  const rows = new Map<string, { document: EditableDocument; doc: Node }>();
  let nextDocument = 0;
  const put = (document: EditableDocument, doc: Node) => {
    const next = { ...document, content: toMarkdown(doc) };
    rows.set(next.id, { document: next, doc });
    return next;
  };
  const build = (content: string, outline: ReadonlyArray<string> = []) => {
    const parsed = parseMarkdown(content);
    const nodes: Node[] = [];
    parsed.forEach((child) => nodes.push(child));
    for (const intent of outline) nodes.push(documentSchema.nodes.pending!.create({ intent }));
    return ensureIds(new Transform(documentSchema.node("doc", null, nodes)), mint).doc;
  };
  for (const row of initial)
    put(
      {
        id: row.id,
        conversationId: CONVERSATION,
        projectId: null,
        title: row.title,
        content: "",
        revision: 0,
        lastEditedBy: "model",
        canEdit: true,
        createdAt: stamp,
        updatedAt: stamp,
      },
      build(row.content),
    );
  const write = (documentId: string, doc: Node, by: "user" | "model") => {
    const current = rows.get(documentId)!;
    return put(
      { ...current.document, revision: current.document.revision + 1, lastEditedBy: by },
      doc,
    );
  };
  const service: DocumentToolService = {
    list: () => Effect.sync(() => [...rows.values()].map((row) => row.document)),
    read: (_userId, documentId) =>
      Effect.sync(() => {
        const row = rows.get(documentId);
        return row ? { document: row.document, doc: row.doc, comments: [] } : null;
      }),
    create: (_userId, input) =>
      Effect.sync(() => {
        const doc = build(input.content, input.outline);
        const document = put(
          {
            id: `doc-${++nextDocument}`,
            conversationId: input.conversationId ?? null,
            projectId: input.projectId ?? null,
            canEdit: true,
            title: input.title,
            content: "",
            revision: 0,
            lastEditedBy: "model",
            createdAt: stamp,
            updatedAt: stamp,
          },
          doc,
        );
        const planned: string[] = [];
        doc.forEach((block) => {
          if (block.type.name === "pending") planned.push(blockIdOf(block)!);
        });
        return { outcome: "created" as const, document, planned };
      }),
    apply: (_userId, input) =>
      Effect.sync(() => {
        const row = rows.get(input.documentId)!;
        const applied = applyTreeEdit(row.doc, input.edit, input.seen);
        if ("outcome" in applied) return { ...applied, document: row.document };
        if (!applied.tr.docChanged)
          return { outcome: "unchanged" as const, document: row.document, touched: [] };
        return {
          outcome: "updated" as const,
          document: write(input.documentId, ensureIds(applied.tr, mint).doc, "model"),
          touched: applied.touched,
        };
      }),
    rewrite: (_userId, input) =>
      Effect.sync(() => {
        const row = rows.get(input.documentId)!;
        return write(
          input.documentId,
          ensureIds(
            replaceDifference(new Transform(row.doc), build(input.content, input.outline)),
            mint,
          ).doc,
          "model",
        );
      }),
    discard: (_userId, documentId) => Effect.sync(() => void rows.delete(documentId)),
    moveToProject: () => Effect.die("no streamed creations in these tests"),
    beginLive: () => Effect.succeed(null),
    updateLive: () => Effect.succeed(false),
    settleLive: () => Effect.die("no live edits in these tests"),
    revertLive: () => Effect.void,
    assistantComment: (_userId, input) =>
      Effect.succeed(
        input.thread
          ? { outcome: "commented" as const, thread: input.thread }
          : { outcome: "not_found" as const, message: "No block with that id." },
      ),
  };
  /** What the person's editor does: a user-attributed change. */
  const userWrite = (documentId: string, markdown: string) => {
    const row = rows.get(documentId)!;
    write(
      documentId,
      replaceDifference(new Transform(row.doc), parseMarkdown(markdown)).doc,
      "user",
    );
  };
  /** A paragraph a person types after one block, with its own fresh ID, as an editor gives it. */
  const userInsert = (documentId: string, afterIndex: number, text: string) => {
    const row = rows.get(documentId)!;
    let position = 0;
    for (let index = 0; index <= afterIndex; index++) position += row.doc.child(index).nodeSize;
    const paragraph = documentSchema.nodes.paragraph!.create(
      { id: "typed1" },
      documentSchema.text(text),
    );
    write(documentId, new Transform(row.doc).insert(position, paragraph).doc, "user");
  };
  return { service, rows, userWrite, userInsert };
}
const prepare = (
  service: DocumentToolService,
  openDocumentId?: string,
  selectedBlocks?: string[],
) =>
  Effect.runPromise(
    prepareDocumentTools({
      service,
      userId: "user",
      conversationId: CONVERSATION,
      messageId: "message-1",
      openDocumentId,
      selectedBlocks,
      writeGuard: () => Effect.void,
    }),
  );
type Tools = Awaited<ReturnType<typeof prepare>>;
const call = (tools: Tools, name: string, params: unknown) =>
  Effect.runPromise(
    (
      tools.group.handlers as Record<
        string,
        (raw: unknown) => Effect.Effect<Record<string, unknown>>
      >
    )[name]!(params),
  );
/** The trailing context as one string, and marked as sent like a real request. */
const send = (tools: Tools) => {
  const messages = tools.messages();
  tools.sent({ content: messages.map((message) => ({ content: String(message.content) })) });
  return messages.map((message) => String(message.content));
};

describe("document tools parameter transport", () => {
  it.each([
    ["create_document", { title: "Checklist" }],
    ["edit_document", { find: "before" }],
    ["read_chat_document", { fromBlock: "b1" }],
  ] as const)(
    "accepts a %s call with omitted keys for the handler to correct",
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

describe("document tools", () => {
  it("sends nothing until a document exists, then the policy and its XML view", async () => {
    const { service } = fakeService();
    const tools = await prepare(service);
    expect(tools.messages()).toEqual([]);
    const created = await call(tools, "create_document", {
      title: "Brief",
      content: "# Brief\n\nOne line.",
      outline: ["Goals", "Plan of work"],
    });
    expect(created).toMatchObject({ outcome: "created", documentId: "doc-1", revision: 0 });
    expect(created.blocks).toHaveLength(2);
    const [policy, view] = send(tools);
    expect(policy).toContain("<application-policy>");
    expect(view).toContain(
      '<document id="doc-1" title="Brief" revision="0" lastEditedBy="model" editedSinceYourLastWrite="false" focused="true">',
    );
    expect(view).toContain('<h1 id="b1">Brief</h1>');
    expect(view).toContain(`<pending id="${(created.blocks as string[])[0]}" intent="Goals"/>`);
  });

  it("fills a planned section by its id and shows only what changed after", async () => {
    const { service } = fakeService();
    const tools = await prepare(service);
    const intro = Array.from({ length: 12 }, (_, index) => `Background point ${index}.`).join(
      "\n\n",
    );
    const created = await call(tools, "create_document", {
      title: "Brief",
      content: `# Brief\n\n${intro}`,
      outline: ["Goals"],
    });
    const first = send(tools);
    const pending = (created.blocks as string[])[0]!;
    const filled = await call(tools, "edit_document", {
      target: pending,
      content: "## Goals\n\nShip it.",
    });
    expect(filled).toMatchObject({ outcome: "updated", revision: 1 });
    const after = send(tools);
    // The first view stays byte for byte, so the cached prefix holds; the change rides after it.
    expect(after[1]).toBe(first[1]);
    expect(after[2]).toContain('<changes since="0">');
    expect(after[2]).toContain("<removed ids=");
    expect(after[2]).toContain("Ship it.");
    expect(after[2]).not.toContain("<h1");
  });

  it("refuses to replace text in a document the focus left that changed since its first view", async () => {
    const { service } = fakeService([
      { id: "doc-1", title: "One", content: "Intro\n\nOutro" },
      { id: "doc-2", title: "Two", content: "Other" },
    ]);
    const tools = await prepare(service, "doc-1");
    send(tools);
    expect(
      await call(tools, "edit_document", {
        documentId: "doc-1",
        target: "b1",
        content: "New intro",
      }),
    ).toMatchObject({ outcome: "updated" });
    send(tools);
    // Reading the other document moves the focus; the first one's changes leave the requests.
    await call(tools, "read_chat_document", { documentId: "doc-2" });
    send(tools);
    expect(
      await call(tools, "edit_document", { documentId: "doc-1", target: "b1", content: "Again" }),
    ).toMatchObject({ outcome: "conflict" });
    // Unchanged since the first view: still known.
    expect(
      await call(tools, "edit_document", { documentId: "doc-1", target: "b2", content: "End" }),
    ).toMatchObject({ outcome: "updated" });
  });

  it("refuses to replace a block the model was never sent, then allows it once sent", async () => {
    const { service } = fakeService([{ id: "doc-1", title: "Plan", content: "Intro\n\nOutro" }]);
    const tools = await prepare(service, "doc-1");
    // Rendered for a budget or a comparison only: not seen.
    tools.messages();
    const blind = await call(tools, "edit_document", { target: "b1", content: "New intro" });
    expect(blind).toMatchObject({ outcome: "conflict" });
    send(tools);
    expect(
      await call(tools, "edit_document", { target: "b1", content: "New intro" }),
    ).toMatchObject({
      outcome: "updated",
    });
  });

  it("keeps a person's change: a block they edited after the model read it is refused", async () => {
    const { service, userWrite } = fakeService([
      { id: "doc-1", title: "Plan", content: "Intro\n\nOutro" },
    ]);
    const tools = await prepare(service, "doc-1");
    send(tools);
    userWrite("doc-1", "Intro, typed by the person\n\nOutro");
    await Effect.runPromise(tools.refresh());
    const result = await call(tools, "edit_document", { target: "b1", content: "Model intro" });
    expect(result).toMatchObject({
      outcome: "conflict",
      message: expect.stringContaining("keep their change"),
    });
    // The next request shows their change and flags it.
    const [, , update] = send(tools);
    expect(update).toContain("typed by the person");
    expect(update).toContain('editedSinceYourLastWrite="true"');
  });

  it("changes text inside a block with find, and explains misses and repeats", async () => {
    const { service } = fakeService([
      { id: "doc-1", title: "Plan", content: "Ship **today**\n\nShip later" },
    ]);
    const tools = await prepare(service, "doc-1");
    send(tools);
    expect(await call(tools, "edit_document", { find: "nothing", content: "x" })).toMatchObject({
      outcome: "no_match",
    });
    expect(await call(tools, "edit_document", { find: "Ship", content: "Send" })).toMatchObject({
      outcome: "ambiguous",
    });
    // The model's own words for the fields still land.
    expect(
      await call(tools, "edit_document", { old_string: "**today**", new_string: "**now**" }),
    ).toMatchObject({
      outcome: "updated",
    });
  });

  it("names the selected blocks in the focused view", async () => {
    const { service } = fakeService([
      { id: "doc-1", title: "Plan", content: "One\n\nTwo\n\nThree" },
    ]);
    const tools = await prepare(service, "doc-1", ["b2", "b3", "elsewhere"]);
    const [, view] = send(tools);
    expect(view).toContain('selected="b2 b3"');
  });

  it("windows a long document by block and continues from where it ended", async () => {
    const line = "x".repeat(400);
    const content = Array.from({ length: 100 }, (_, index) => `${index} ${line}`).join("\n\n");
    const { service } = fakeService([{ id: "doc-1", title: "Long", content }]);
    const tools = await prepare(service, "doc-1");
    const [, view = ""] = send(tools);
    expect(view.length).toBeLessThan(FOCUS_CHARS + 2_000);
    const next = /read_chat_document with (\{[^}]+\})/.exec(view)![1]!;
    expect(JSON.parse(next)).toMatchObject({ fromBlock: expect.any(String) });
    await call(tools, "read_chat_document", { documentId: "doc-1", ...JSON.parse(next) });
    const [, , update] = send(tools);
    expect(update).toContain("<gap blocks=");
  });

  it("opens a long document's view at the selection when it lies past the first window", async () => {
    const line = "x".repeat(400);
    const content = Array.from({ length: 100 }, (_, index) => `${index} ${line}`).join("\n\n");
    const { service, rows } = fakeService([{ id: "doc-1", title: "Long", content }]);
    const late = blockIdOf(rows.get("doc-1")!.doc.child(80))!;
    const tools = await prepare(service, "doc-1", [late]);
    const view = send(tools).join("\n");
    expect(view).toContain(`<p id="${late}">80 `);
    expect(view).toContain(`selected="${late}"`);
  });

  it("places a block added at a window's start after its neighbour in the document", async () => {
    const line = "x".repeat(400);
    const content = Array.from({ length: 100 }, (_, index) => `${index} ${line}`).join("\n\n");
    const { service, userInsert, rows } = fakeService([{ id: "doc-1", title: "Long", content }]);
    const doc = rows.get("doc-1")!.doc;
    // A late selection opens the view two blocks before it, at block 78.
    const tools = await prepare(service, "doc-1", [blockIdOf(doc.child(80))!]);
    send(tools);
    // A person adds a block after 78: the selection moves down one, and the
    // window now opens on the new block.
    userInsert("doc-1", 78, "Inserted");
    await Effect.runPromise(tools.refresh());
    const update = send(tools).at(-1)!;
    expect(update).toContain(`<added after="${blockIdOf(doc.child(78))}">`);
  });

  it("names a steer's new selection though the document did not change", async () => {
    const { service, rows } = fakeService([
      { id: "doc-1", title: "One", content: "First" },
      { id: "doc-2", title: "Two", content: "Alpha\n\nBeta" },
    ]);
    const [alpha, beta] = [0, 1].map((index) => blockIdOf(rows.get("doc-2")!.doc.child(index))!);
    const tools = await prepare(service, "doc-1");
    send(tools);
    tools.focus("doc-2", [alpha!], undefined);
    await Effect.runPromise(tools.refresh());
    expect(send(tools).at(-1)).toContain(`selected="${alpha}"`);
    // A steer selects the other block; nothing in the document changed.
    tools.focus("doc-2", [beta!], undefined);
    await Effect.runPromise(tools.refresh());
    const update = send(tools).at(-1)!;
    expect(update).toContain(`selected="${beta}"`);
    expect(update).not.toContain(`selected="${alpha}"`);
  });

  it("sends nothing more for a person's earlier edit once it has been seen", async () => {
    const { service, userWrite } = fakeService([{ id: "doc-1", title: "One", content: "Intro" }]);
    userWrite("doc-1", "Intro, edited by the person");
    const tools = await prepare(service, "doc-1");
    expect(send(tools)).toHaveLength(2);
    // Nothing changed: the header's edited flag flipping must not resend the document.
    expect(send(tools)).toHaveLength(2);
    expect(send(tools)).toHaveLength(2);
  });

  it("names a new selection that arrives after an edit", async () => {
    const { service, userWrite, rows } = fakeService([
      { id: "doc-1", title: "One", content: "Alpha\n\nBeta\n\nGamma" },
    ]);
    const [alpha, beta] = [0, 1].map((index) => blockIdOf(rows.get("doc-1")!.doc.child(index))!);
    const tools = await prepare(service, "doc-1", [alpha!]);
    send(tools);
    userWrite("doc-1", "Alpha\n\nBeta\n\nGamma, edited");
    tools.focus("doc-1", [beta!], undefined);
    await Effect.runPromise(tools.refresh());
    expect(send(tools).at(-1)).toContain(`selected="${beta}"`);
  });

  it("opens at the selection itself when the blocks before it are too long to fit too", async () => {
    const long = "y".repeat(13_000);
    const content = [
      ...Array.from({ length: 10 }, (_, index) => `${index} ${"x".repeat(3_000)}`),
      `long one ${long}`,
      `long two ${long}`,
      "The selected line",
    ].join("\n\n");
    const { service, rows } = fakeService([{ id: "doc-1", title: "Long", content }]);
    const selected = blockIdOf(rows.get("doc-1")!.doc.lastChild!)!;
    const tools = await prepare(service, "doc-1", [selected]);
    const view = send(tools).join("\n");
    expect(view).toContain("The selected line");
    expect(view).toContain(`selected="${selected}"`);
  });

  it("never reports blocks that only left the window as removed", async () => {
    const line = "x".repeat(400);
    const content = Array.from({ length: 100 }, (_, index) => `${index} ${line}`).join("\n\n");
    const { service, userWrite } = fakeService([{ id: "doc-1", title: "Long", content }]);
    const tools = await prepare(service, "doc-1");
    const [, view = ""] = send(tools);
    // The window shifts by three blocks, as it does to show a write.
    const third = [...view.matchAll(/<p id="([a-z0-9]+)"/g)][3]![1]!;
    await call(tools, "read_chat_document", { documentId: "doc-1", fromBlock: third });
    // A person changes a block in the window; the three it left behind all still exist.
    userWrite("doc-1", content.replace(`10 ${line}`, `10 changed`));
    await Effect.runPromise(tools.refresh());
    const update = send(tools).at(-1)!;
    expect(update).not.toContain("<removed");
  });

  it("keeps showing a document focused partway through the answer in every later request", async () => {
    const { service } = fakeService([
      { id: "doc-1", title: "One", content: "First document text" },
      { id: "doc-2", title: "Two", content: "Second document text" },
    ]);
    const tools = await prepare(service, "doc-1");
    expect(send(tools).join("\n")).toContain("First document text");
    // The reader moves the focus, as a steer does, between two requests.
    tools.focus("doc-2", undefined, undefined);
    // Each round refreshes before its request, as streaming does.
    await Effect.runPromise(tools.refresh());
    expect(send(tools).join("\n")).toContain("Second document text");
    await Effect.runPromise(tools.refresh());
    expect(send(tools).join("\n")).toContain("Second document text");
  });

  it("requires an id among several documents, and lists them", async () => {
    const { service } = fakeService([
      { id: "doc-1", title: "One", content: "a" },
      { id: "doc-2", title: "Two", content: "b" },
    ]);
    const tools = await prepare(service);
    const listed = await call(tools, "list_chat_documents", {});
    expect((listed.documents as unknown[]).length).toBe(2);
    expect(await call(tools, "read_chat_document", {})).toMatchObject({ outcome: "listed" });
  });

  it("puts a new document in the project when the person may edit it, unless asked for the chat", async () => {
    const inProject = async (canEdit: boolean, scope?: "chat") => {
      const { service, rows } = fakeService();
      const tools = await Effect.runPromise(
        prepareDocumentTools({
          service,
          userId: "user",
          conversationId: CONVERSATION,
          messageId: "message-1",
          writeGuard: () => Effect.void,
          project: { id: "project-1", name: "Launch", canEdit },
        }),
      );
      const result = await call(tools, "create_document", {
        title: "Notes",
        content: "x",
        ...(scope ? { scope } : {}),
      });
      return { result, row: [...rows.values()][0]?.document };
    };
    expect((await inProject(true)).row).toMatchObject({
      projectId: "project-1",
      conversationId: null,
    });
    expect((await inProject(true, "chat")).row).toMatchObject({
      projectId: null,
      conversationId: CONVERSATION,
    });
    expect((await inProject(false)).row).toMatchObject({
      projectId: null,
      conversationId: CONVERSATION,
    });
  });

  it("never puts the document body in a tool result", async () => {
    const { service } = fakeService([{ id: "doc-1", title: "Plan", content: "SECRET BODY" }]);
    const tools = await prepare(service, "doc-1");
    send(tools);
    const results = [
      await call(tools, "read_chat_document", { documentId: "doc-1" }),
      await call(tools, "edit_document", { target: "b1", content: "SECRET NEXT" }),
      await call(tools, "edit_document", { find: "missing", content: "x" }),
    ];
    for (const result of results) expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});
