import { describe, expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";
import type { AttachmentWithBlob } from "~/modules/attachments/server/repo.ts";
import { buildHistoryMessages, type HistoryMessage, type PromptDeps } from "./prompt.ts";

type Row = AttachmentWithBlob & { messageId: string; position: number };

let rowCount = 0;
const row = (overrides: Partial<Row> & { mediaType: string; messageId: string }): Row => {
  const n = ++rowCount;
  return {
    id: `attachment-${n}`,
    userId: "user-1",
    fileName: `file-${n}`,
    blobId: `blob-${n}`,
    storageKey: `blobs/user-1/aa/bb/${n}`,
    size: 10,
    parsedText: null,
    parsedWith: null,
    position: 0,
    ...overrides,
  };
};

const bytes = (value: string) => new TextEncoder().encode(value);

interface Harness {
  deps: PromptDeps;
  get: ReturnType<typeof vi.fn>;
  parsePdf: ReturnType<typeof vi.fn>;
  cacheParsedText: ReturnType<typeof vi.fn>;
}

const harness = (options: {
  rows: ReadonlyArray<Row>;
  blobs?: Record<string, string>;
  parserKind?: string | null;
  parsed?: string;
}): Harness => {
  const get = vi.fn((key: string) =>
    Effect.succeed(bytes(options.blobs?.[key] ?? `bytes of ${key}`)),
  );
  const parsePdf = vi.fn(() =>
    Effect.succeed({
      text: options.parsed ?? "extracted body",
      parsedWith: options.parserKind ?? "local",
      truncated: false,
    }),
  );
  const cacheParsedText = vi.fn(() => Effect.void);
  return {
    get,
    parsePdf,
    cacheParsedText,
    deps: {
      attachments: {
        listWithBlobsForMessages: () => Effect.succeed(options.rows),
        cacheParsedText,
      },
      store: { get },
      parser: {
        parsePdf,
        availability: () =>
          Effect.succeed({
            configured: true,
            enabled: true,
            kind: options.parserKind === undefined ? "local" : options.parserKind,
          }),
      },
    } as PromptDeps,
  };
};

const build = (
  deps: PromptDeps,
  messages: ReadonlyArray<HistoryMessage>,
  options: { webToolsEnabled?: boolean; modelSupportsFiles?: boolean } = {},
) =>
  Effect.runPromise(
    buildHistoryMessages(deps, {
      messages,
      webToolsEnabled: options.webToolsEnabled ?? false,
      modelSupportsFiles: options.modelSupportsFiles ?? false,
    }),
  );

const user = (id: string, content: string): HistoryMessage => ({ id, role: "user", content });

describe("buildHistoryMessages without attachments", () => {
  it("passes plain strings through and strips stale citation markers", async () => {
    const { deps } = harness({ rows: [] });
    const messages = await build(deps, [
      user("m1", "hello"),
      { id: "m2", role: "assistant", content: "an answer[^1]" },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "an answer" },
    ]);
  });

  it("keeps markers when a web tool is armed for this generation", async () => {
    const { deps } = harness({ rows: [] });
    const messages = await build(
      deps,
      [{ id: "m1", role: "assistant", content: "an answer[^1]" }],
      { webToolsEnabled: true },
    );
    expect(messages).toEqual([{ role: "assistant", content: "an answer[^1]" }]);
  });
});

describe("buildHistoryMessages timestamps", () => {
  const createdAt = new Date("2026-09-04T12:00:00Z");
  const editedAt = new Date("2026-09-05T01:00:00Z");
  const completedAt = new Date("2026-09-05T01:00:30Z");

  it("adds stable UTC metadata without changing stored text or system instructions", async () => {
    const { deps } = harness({ rows: [] });
    const history = [
      { ...user("m1", "hello"), createdAt },
      { id: "m2", role: "assistant" as const, content: "answer[^1]", createdAt, completedAt },
      { id: "s1", role: "system" as const, content: "policy", createdAt },
    ];
    const first = await build(deps, history);
    expect(first).toEqual(await build(deps, history));
    expect(first).toEqual([
      { role: "user", content: `[Sent: ${createdAt.toISOString()}]\nhello` },
      { role: "assistant", content: `[Completed: ${completedAt.toISOString()}]\nanswer` },
      { role: "system", content: "policy" },
    ]);
    expect(history[0]?.content).toBe("hello");
    expect(history[1]?.content).toBe("answer[^1]");
  });

  it("distinguishes edits from original sends and retries from original row creation", async () => {
    const { deps } = harness({ rows: [] });
    const rendered = await build(deps, [
      { ...user("m1", "edited question"), createdAt, editedAt },
      { id: "m2", role: "assistant", content: "retried answer", createdAt, completedAt },
    ]);
    expect(rendered[0]?.content).toContain(
      `Sent: ${createdAt.toISOString()}; edited: ${editedAt.toISOString()}`,
    );
    expect(rendered[1]?.content).toContain(`Completed: ${completedAt.toISOString()}`);
    expect(rendered[1]?.content).not.toContain(createdAt.toISOString());
  });

  it("adds metadata to attachment-only messages without disturbing file order", async () => {
    const { deps } = harness({
      rows: [row({ messageId: "m1", mediaType: "image/png", fileName: "a.png" })],
    });
    const [rendered] = await build(deps, [{ ...user("m1", ""), createdAt }]);
    expect(rendered?.content).toEqual([
      expect.objectContaining({ type: "file", fileName: "a.png" }),
      { type: "text", text: `[Sent: ${createdAt.toISOString()}]\n` },
    ]);
  });

  it("labels a legacy assistant creation time and omits invalid dates", async () => {
    const { deps } = harness({ rows: [] });
    const rendered = await build(deps, [
      { id: "m1", role: "assistant", content: "old answer", createdAt, completedAt: null },
      { ...user("m2", "hello"), createdAt: new Date("invalid") },
    ]);
    expect(rendered[0]?.content).toBe(`[Created: ${createdAt.toISOString()}]\nold answer`);
    expect(rendered[1]?.content).toBe("hello");
  });
});

describe("buildHistoryMessages with attachments", () => {
  it("puts attachments before the user's words, in position order", async () => {
    const { deps } = harness({
      rows: [
        row({
          messageId: "m1",
          position: 0,
          mediaType: "image/png",
          fileName: "shot.png",
          storageKey: "blobs/user-1/aa/bb/img",
        }),
        row({
          messageId: "m1",
          position: 1,
          mediaType: "text/plain",
          fileName: "notes.md",
          storageKey: "blobs/user-1/aa/bb/txt",
        }),
      ],
      blobs: { "blobs/user-1/aa/bb/img": "PNGDATA", "blobs/user-1/aa/bb/txt": "# heading" },
    });

    const [message] = await build(deps, [user("m1", "what is this?")]);
    expect(message).toEqual({
      role: "user",
      content: [
        {
          type: "file",
          mediaType: "image/png",
          fileName: "shot.png",
          data: bytes("PNGDATA"),
        },
        {
          type: "text",
          text: "Attached file: notes.md\n```markdown\n# heading\n```",
        },
        { type: "text", text: "what is this?" },
      ],
    });
    // The bytes reach the provider as a Uint8Array, not a base64 string.
    expect(
      (message as unknown as { content: Array<{ data?: unknown }> }).content[0]?.data,
    ).toBeInstanceOf(Uint8Array);
  });

  it("omits the trailing text part for an attachment-only turn", async () => {
    const { deps } = harness({
      rows: [row({ messageId: "m1", mediaType: "image/png", fileName: "a.png" })],
    });
    const [message] = await build(deps, [user("m1", "   ")]);
    expect((message as unknown as { content: unknown[] }).content).toHaveLength(1);
  });

  it("leaves messages without attachments as plain strings", async () => {
    const { deps } = harness({
      rows: [row({ messageId: "m2", mediaType: "image/png", fileName: "a.png" })],
    });
    const messages = await build(deps, [user("m1", "first"), user("m2", "second")]);
    expect(messages[0]).toEqual({ role: "user", content: "first" });
    expect(Array.isArray((messages[1] as unknown as { content: unknown }).content)).toBe(true);
  });

  it("reads a blob shared by two turns only once", async () => {
    const shared = "blobs/user-1/aa/bb/shared";
    const { deps, get } = harness({
      rows: [
        row({ messageId: "m1", mediaType: "image/png", storageKey: shared }),
        row({ messageId: "m2", mediaType: "image/png", storageKey: shared }),
      ],
    });
    await build(deps, [user("m1", "a"), user("m2", "b")]);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("buildHistoryMessages PDF delivery", () => {
  const pdfRow = (overrides: Partial<Row> = {}) =>
    row({
      messageId: "m1",
      mediaType: "application/pdf",
      fileName: "paper.pdf",
      storageKey: "blobs/user-1/aa/bb/pdf",
      ...overrides,
    });

  it("sends the file natively when the model reads files", async () => {
    const { deps, parsePdf } = harness({
      rows: [pdfRow()],
      blobs: { "blobs/user-1/aa/bb/pdf": "%PDF-1.4" },
    });
    const [message] = await build(deps, [user("m1", "summarize")], { modelSupportsFiles: true });
    expect((message as unknown as { content: Array<{ type: string }> }).content[0]).toEqual({
      type: "file",
      mediaType: "application/pdf",
      fileName: "paper.pdf",
      data: bytes("%PDF-1.4"),
    });
    expect(parsePdf).not.toHaveBeenCalled();
  });

  it("parses locally and fences the text when the model does not", async () => {
    const { deps, parsePdf, cacheParsedText } = harness({
      rows: [pdfRow({ blobId: "blob-pdf" })],
      parsed: "page one",
    });
    const [message] = await build(deps, [user("m1", "summarize")]);
    expect(
      (message as unknown as { content: Array<{ type: string; text?: string }> }).content[0],
    ).toEqual({
      type: "text",
      text: "Text extracted from attached PDF: paper.pdf\n```\npage one\n```",
    });
    expect(parsePdf).toHaveBeenCalledTimes(1);
    expect(cacheParsedText).toHaveBeenCalledWith({
      blobId: "blob-pdf",
      text: "page one",
      parsedWith: "local",
    });
  });

  it("reuses cached text produced by the configured parser", async () => {
    const { deps, parsePdf, get } = harness({
      rows: [pdfRow({ parsedText: "cached body", parsedWith: "local" })],
    });
    const [message] = await build(deps, [user("m1", "summarize")]);
    expect(
      (message as unknown as { content: Array<{ text?: string }> }).content[0]?.text,
    ).toContain("cached body");
    expect(parsePdf).not.toHaveBeenCalled();
    // Not even the bytes are read when the cache hits.
    expect(get).not.toHaveBeenCalled();
  });

  it("re-parses when the cache came from a different backend", async () => {
    const { deps, parsePdf } = harness({
      rows: [pdfRow({ parsedText: "stale body", parsedWith: "legacy-ocr" })],
      parserKind: "local",
      parsed: "fresh body",
    });
    const [message] = await build(deps, [user("m1", "summarize")]);
    expect(
      (message as unknown as { content: Array<{ text?: string }> }).content[0]?.text,
    ).toContain("fresh body");
    expect(parsePdf).toHaveBeenCalledTimes(1);
  });
});

describe("assistant image replay", () => {
  const imageRow = row({ messageId: "answer", mediaType: "image/png", fileName: "generated.png" });
  const image = {
    v: 1 as const,
    attachment: {
      id: imageRow.id,
      fileName: imageRow.fileName,
      mediaType: imageRow.mediaType,
      size: imageRow.size,
      kind: "image" as const,
    },
    textOffset: 2,
    turnIndex: 1,
    eventIndex: 3,
    callIndex: 1,
  };
  const details = [
    {
      type: "reasoning.encrypted" as const,
      data: "opaque",
      format: "google-gemini-v1" as const,
      index: 7,
      id: "signed",
    },
  ];
  const message: HistoryMessage = {
    id: "answer",
    role: "assistant",
    content: "😀after",
    assistantOutput: { v: 1, images: [image] },
    providerReplay: {
      v: 1,
      providerId: "provider",
      modelKey: "model",
      turns: [{ turnIndex: 0, startOffset: 0, endOffset: 2, reasoningDetails: details }],
    },
  };
  const input = {
    messages: [message],
    modelSupportsFiles: false,
    modelSupportsVision: true,
    webToolsEnabled: false,
    expandAssistantTurns: true,
    modelIdentity: { providerId: "provider", modelKey: "model" },
  };
  it.effect(
    "keeps an unsigned trailing image after a completed signed round with UTF-16 offsets",
    () =>
      Effect.gen(function* () {
        const { deps } = harness({ rows: [imageRow] });
        const replay = yield* buildHistoryMessages(deps, input);
        expect(replay).toHaveLength(2);
        expect(replay[0]).toMatchObject({
          role: "assistant",
          content: [{ type: "text", text: "😀" }],
          options: { openrouter: { imageReplay: true, reasoningDetails: details } },
        });
        expect(replay[1]).toMatchObject({
          role: "assistant",
          content: [{ type: "file" }, { type: "text", text: "after" }],
          options: { openrouter: { reasoningDetails: [] } },
        });
      }),
  );
  for (const webToolsEnabled of [false, true]) {
    it.effect(`normalizes fileless empty-metadata replay with web tools ${webToolsEnabled}`, () =>
      Effect.gen(function* () {
        const { deps } = harness({ rows: [] });
        const content = "Answer[^1]";
        const completedAt = new Date("2026-09-08T12:00:00Z");
        const history: HistoryMessage = {
          ...message,
          content,
          assistantOutput: null,
          completedAt,
          createdAt: new Date("2026-09-01T00:00:00Z"),
          providerReplay: {
            ...message.providerReplay!,
            turns: [
              { turnIndex: 0, startOffset: 0, endOffset: content.length, reasoningDetails: [] },
            ],
          },
        };
        const rendered = yield* buildHistoryMessages(deps, {
          ...input,
          webToolsEnabled,
          messages: [history],
        });
        expect(rendered).toEqual([
          {
            role: "assistant",
            content: [
              { type: "text", text: `[Completed: ${completedAt.toISOString()}]\n` },
              { type: "text", text: webToolsEnabled ? content : "Answer" },
            ],
            options: { openrouter: { imageReplay: true, reasoningDetails: [] } },
          },
        ]);
        expect(history.content).toBe(content);
      }),
    );
  }
  for (const mode of ["empty metadata", "incompatible model", "collapsed estimate"] as const) {
    it.effect(`normalizes raw slices without moving images for ${mode}`, () =>
      Effect.gen(function* () {
        const { deps } = harness({ rows: [imageRow] });
        const prefix = "😀before[^1]";
        const content = prefix + "after[^2]";
        const completedAt = new Date("2026-09-08T12:00:00Z");
        const history: HistoryMessage = {
          ...message,
          content,
          completedAt,
          assistantOutput: {
            v: 1,
            images: [{ ...image, turnIndex: 0, textOffset: prefix.length }],
          },
          providerReplay: {
            ...message.providerReplay!,
            turns: [
              {
                turnIndex: 0,
                startOffset: 0,
                endOffset: content.length,
                reasoningDetails: mode === "empty metadata" ? [] : details,
              },
            ],
          },
        };
        const rendered = yield* buildHistoryMessages(deps, {
          ...input,
          messages: [history],
          ...(mode === "incompatible model"
            ? { modelIdentity: { providerId: "other", modelKey: "model" } }
            : {}),
          ...(mode === "collapsed estimate"
            ? { expandAssistantTurns: false, deferAssistantBytes: true }
            : {}),
        });
        expect(rendered).toHaveLength(1);
        expect(rendered[0]?.content).toEqual([
          { type: "text", text: `[Completed: ${completedAt.toISOString()}]\n` },
          { type: "text", text: "😀before" },
          expect.objectContaining({ type: "file", fileName: "generated.png" }),
          { type: "text", text: "after" },
        ]);
        expect(JSON.stringify(rendered)).not.toContain("opaque");
        expect(history.assistantOutput?.images[0]?.textOffset).toBe(prefix.length);
        expect(history.content).toBe(content);
      }),
    );
  }
  it.effect(
    "annotates outside signed text and tools while normalizing an unsigned trailing turn",
    () =>
      Effect.gen(function* () {
        const { deps } = harness({ rows: [imageRow] });
        const chat = {
          listToolCalls: () =>
            Effect.succeed([
              {
                turnIndex: 0,
                toolName: "inspect",
                providerCallId: "call",
                arguments: { target: "image" },
                status: "complete",
                result: { ok: true },
              },
            ]),
        } as unknown as NonNullable<PromptDeps["chat"]>;
        const prefix = "😀before[^1]";
        const signedText = prefix + "after[^2]";
        const content = signedText + "tail[^3]";
        const completedAt = new Date("2026-09-08T12:00:00Z");
        const history: HistoryMessage = {
          ...message,
          content,
          completedAt,
          assistantOutput: {
            v: 1,
            images: [{ ...image, turnIndex: 0, textOffset: prefix.length }],
          },
          providerReplay: {
            ...message.providerReplay!,
            turns: [
              {
                turnIndex: 0,
                startOffset: 0,
                endOffset: signedText.length,
                reasoningDetails: details,
              },
            ],
          },
        };
        const original = structuredClone(history);
        const rendered = yield* buildHistoryMessages(
          { ...deps, chat },
          { ...input, messages: [history] },
        );
        expect(rendered).toHaveLength(4);
        expect(rendered[0]).toEqual({
          role: "user",
          content: `Historical assistant response metadata:\n[Completed: ${completedAt.toISOString()}]\nCitation markers in the following historical assistant response are retained for provider replay only. Do not reuse these markers in a new answer.\n`,
        });
        expect(rendered[1]).toEqual({
          role: "assistant",
          content: [
            { type: "text", text: prefix },
            expect.objectContaining({ type: "file", fileName: "generated.png" }),
            { type: "text", text: "after[^2]" },
            { type: "tool-call", id: "call", name: "inspect", params: { target: "image" } },
          ],
          options: { openrouter: { imageReplay: true, reasoningDetails: details } },
        });
        expect(rendered[2]).toEqual({
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "call",
              name: "inspect",
              isFailure: false,
              result: { ok: true },
            },
          ],
        });
        expect(rendered[3]).toMatchObject({
          role: "assistant",
          content: [{ type: "text", text: "tail" }],
        });
        expect(history).toEqual(original);
      }),
  );
  it.effect("fails closed when every referenced attachment is absent", () =>
    Effect.gen(function* () {
      const { deps } = harness({ rows: [] });
      const result = yield* Effect.result(buildHistoryMessages(deps, input));
      expect(result._tag).toBe("Failure");
    }),
  );
  it.effect("estimates replay without blob reads and shares retained reads", () =>
    Effect.gen(function* () {
      const { deps, get } = harness({ rows: [imageRow] });
      yield* buildHistoryMessages(deps, { ...input, deferAssistantBytes: true });
      expect(get).not.toHaveBeenCalled();
      const loadedBytes = new Map<string, Uint8Array>();
      yield* buildHistoryMessages(deps, { ...input, loadedBytes });
      yield* buildHistoryMessages(deps, { ...input, loadedBytes });
      expect(get).toHaveBeenCalledTimes(1);
    }),
  );
  it.effect("strips incompatible private metadata without dropping the authorized image", () =>
    Effect.gen(function* () {
      const { deps } = harness({ rows: [imageRow] });
      const replay = yield* buildHistoryMessages(deps, {
        ...input,
        modelIdentity: { providerId: "other", modelKey: "model" },
      });
      expect(replay.every((part) => part.options === undefined)).toBe(true);
      expect(replay[1]).toMatchObject({ content: [{ type: "file" }, { type: "text" }] });
      expect(
        (yield* Effect.result(buildHistoryMessages(deps, { ...input, modelSupportsVision: false })))
          ._tag,
      ).toBe("Failure");
    }),
  );
  it.effect("preserves signed fileless replay even without attachment rows", () =>
    Effect.gen(function* () {
      const { deps } = harness({ rows: [] });
      const replay = yield* buildHistoryMessages(deps, {
        ...input,
        messages: [{ ...message, content: "😀", assistantOutput: null }],
      });
      expect(replay[0]).toMatchObject({
        options: { openrouter: { imageReplay: true, reasoningDetails: details } },
      });
    }),
  );
});
