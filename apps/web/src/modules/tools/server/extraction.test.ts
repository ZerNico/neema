import { describe, expect, it } from "vitest";
import { contentKind, readCapped } from "./extraction.ts";

describe("what read_url can read", () => {
  it("classifies by declared type, and a .pdf path a server calls octet-stream", () => {
    expect(contentKind("text/html; charset=utf-8", "https://a.test/")).toBe("html");
    expect(contentKind("application/pdf", "https://a.test/x")).toBe("pdf");
    expect(contentKind("application/octet-stream", "https://a.test/paper.PDF")).toBe("pdf");
    expect(contentKind("application/octet-stream", "https://a.test/file.bin")).toBeNull();
    expect(contentKind("application/ld+json", "https://a.test/")).toBe("json");
    expect(contentKind("text/csv", "https://a.test/")).toBe("csv");
    expect(contentKind("text/markdown", "https://a.test/")).toBe("markdown");
    expect(contentKind("image/png", "https://a.test/")).toBeNull();
  });

  it("stops reading at the cap and says it did", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6).fill(1));
        controller.enqueue(new Uint8Array(6).fill(2));
        controller.close();
      },
    });
    const read = await readCapped(body, 8);
    expect(read.data).toEqual(new Uint8Array([1, 1, 1, 1, 1, 1, 2, 2]));
    expect(read.truncated).toBe(true);
    const exact = await readCapped(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4));
          controller.close();
        },
      }),
      4,
    );
    expect(exact.truncated).toBe(false);
  });
});
