import { Effect, Redacted } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MISTRAL_DEFAULT_BASE_URL,
  mistralBaseUrl,
  mistralEndpoint,
  mistralOcr,
  readMistralBody,
} from "./scan-readers.ts";

const input = {
  baseUrl: "https://ocr.example/v1",
  key: Redacted.make("test-key"),
  pdf: new Uint8Array([1, 2, 3]),
};

const streamedResponse = (chunks: string[], init: ResponseInit = {}) => {
  let reads = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = chunks[reads++];
        if (next === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(next));
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  return { response: new Response(body, init), cancel, reads: () => reads };
};

afterEach(() => vi.restoreAllMocks());

describe("mistralBaseUrl", () => {
  it("is Mistral's own endpoint when left blank", () => {
    expect(mistralBaseUrl(undefined)).toBe(MISTRAL_DEFAULT_BASE_URL);
    expect(mistralBaseUrl("  ")).toBe(MISTRAL_DEFAULT_BASE_URL);
  });

  it("keeps another service's URL without a trailing slash", () => {
    expect(mistralBaseUrl(" https://ocr.example.eu/v1/ ")).toBe("https://ocr.example.eu/v1");
  });

  it("refuses anything that is not an http(s) URL", () => {
    expect(mistralBaseUrl("ftp://ocr.example")).toBeNull();
    expect(mistralBaseUrl("not a url")).toBeNull();
  });
});

describe("mistralEndpoint", () => {
  it("uses the normalized path, scheme and port for dispatch and identity", () => {
    expect(mistralEndpoint("https://OCR.EXAMPLE:443/v1///")).toBe("https://ocr.example/v1/ocr");
    expect(mistralEndpoint("http://ocr.example:8080/v2")).toBe("http://ocr.example:8080/v2/ocr");
    expect(mistralEndpoint("https://ocr.example/v1?region=eu#ignored")).toBe(
      "https://ocr.example/v1/ocr?region=eu",
    );
  });
});

describe("bounded Mistral body reads", () => {
  it.each([
    ["no length", {}],
    ["a misleading length", { "content-length": "3" }],
    ["decompressed bytes", { "content-length": "3", "content-encoding": "gzip" }],
  ])("cancels overflow with %s", async (_label, headers) => {
    // Fetch exposes decompressed chunks. Tiny limits test the counting without large fixtures.
    const stream = streamedResponse(["1234", "5678", "9", "never read"], { headers });
    await expect(readMistralBody(stream.response, 8)).rejects.toMatchObject({
      reason: "The OCR service response exceeded the byte limit",
      transient: false,
    });
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(stream.reads()).toBe(3);
    expect(stream.response.body?.locked).toBe(false);
  });

  it("rejects a declared oversized body without reading a chunk", async () => {
    const stream = streamedResponse(["never read"], { headers: { "content-length": "9" } });
    await expect(readMistralBody(stream.response, 8)).rejects.toMatchObject({ transient: false });
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(stream.reads()).toBe(0);
  });

  it("counts UTF-8 bytes and preserves characters split across chunks", async () => {
    const bytes = new TextEncoder().encode("café");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 4));
        controller.enqueue(bytes.slice(4));
        controller.close();
      },
    });
    expect(await readMistralBody(new Response(body), 5)).toBe("café");
    const oversized = streamedResponse(["éé", "é"]);
    await expect(readMistralBody(oversized.response, 5)).rejects.toMatchObject({
      transient: false,
    });
    expect(oversized.cancel).toHaveBeenCalledTimes(1);
  });
});

describe("mistralOcr", () => {
  it.each([200, 500])("bounds a declared oversized HTTP %s response", async (status) => {
    const stream = streamedResponse(["never read"], {
      status,
      headers: { "content-length": String(2 * 1024 * 1024) },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(stream.response);
    const failure = await Effect.runPromise(Effect.flip(mistralOcr(input)));
    expect(failure).toMatchObject({
      transient: false,
      reason: expect.stringContaining("byte limit"),
    });
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(stream.reads()).toBe(0);
  });

  it("cancels a chunked error body at its smaller diagnostic limit", async () => {
    const stream = streamedResponse(
      Array.from({ length: 66 }, () => "x".repeat(256)),
      { status: 500 },
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(stream.response);
    const failure = await Effect.runPromise(Effect.flip(mistralOcr(input)));
    expect(failure.reason).toContain("byte limit");
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(stream.reads()).toBe(65);
  });

  it("accepts four valid pages, including reordered results, and ignores unrelated metadata", async () => {
    const pages = [3, 1, 2, 0].map((index) => ({ index, markdown: `Page ${index}` }));
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ pages, usage_info: { pages_processed: 4 } }));
    expect(await Effect.runPromise(mistralOcr({ ...input, pageCount: 4 }))).toEqual({ pages });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://ocr.example/v1/ocr");
  });

  it.each([
    "null",
    "{}",
    '{"pages":null}',
    '{"pages":[null]}',
    '{"pages":[{"index":0.5,"markdown":"Text"}]}',
    '{"pages":[{"index":1e400,"markdown":"Text"}]}',
    '{"pages":[{"index":-1,"markdown":"Text"}]}',
    '{"pages":[{"index":4,"markdown":"Text"}]}',
    '{"pages":[{"index":0,"markdown":42}]}',
    '{"pages":[{"index":0,"markdown":"A"},{"index":0,"markdown":"B"}]}',
    JSON.stringify({
      pages: Array.from({ length: 5 }, (_, index) => ({ index, markdown: "Text" })),
    }),
    "not JSON",
  ])("rejects invalid OCR result shapes (%s)", async (text) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(text));
    const failure = await Effect.runPromise(Effect.flip(mistralOcr(input)));
    expect(failure).toEqual({
      reason: "The OCR service answered with something other than OCR results",
      transient: false,
    });
  });

  it("rejects unused pages beyond the requested subset", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ pages: [{ index: 1, markdown: "Not requested" }] }),
    );
    const failure = await Effect.runPromise(Effect.flip(mistralOcr({ ...input, pageCount: 1 })));
    expect(failure.transient).toBe(false);
  });

  it("preserves ordinary bounded error details and retry-after", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ message: "Slow down" }, { status: 429, headers: { "retry-after": "12" } }),
    );
    expect(await Effect.runPromise(Effect.flip(mistralOcr(input)))).toEqual({
      reason: "The OCR service is rate limiting (HTTP 429): Slow down",
      transient: true,
      retryAfterMs: 12_000,
    });
  });
});
