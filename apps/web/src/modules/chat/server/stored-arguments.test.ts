import { describe, expect, it } from "vitest";
import { debugArguments, storedArguments } from "./stored-arguments.ts";

describe("a stored call's arguments", () => {
  it("keeps what was done and replaces written content with its size and hash", () => {
    const content = "x".repeat(5000);
    expect(
      storedArguments({
        workingRef: "working:abc@3",
        operations: [
          { kind: "setText", slideId: 256, placeholder: "title", text: "Q3 results" },
          { kind: "setText", slideId: 257, placeholder: "body", text: content },
        ],
      }),
    ).toEqual({
      workingRef: "working:abc@3",
      operations: [
        { kind: "setText", slideId: 256, placeholder: "title", text: "Q3 results" },
        {
          kind: "setText",
          slideId: 257,
          placeholder: "body",
          text: { $omitted: "text", chars: 5000, sha256: expect.stringMatching(/^[0-9a-f]{16}$/) },
        },
      ],
    });
  });

  it("never stores image data, and caps long lists", () => {
    const image = `data:image/png;base64,${"iVBORw0KGgo".repeat(20)}`;
    const stored = storedArguments({
      image,
      bytes: new Uint8Array(10),
      ids: Array.from({ length: 45 }, (_, index) => index),
    }) as Record<string, unknown>;
    expect(stored.image).toEqual({ $omitted: "bytes", chars: image.length });
    expect(stored.bytes).toEqual({ $omitted: "bytes", bytes: 10 });
    expect(stored.ids).toHaveLength(41);
    expect((stored.ids as unknown[]).at(-1)).toEqual({ $omitted: "items", count: 5 });
  });

  it("keeps only the argument names when even the trimmed copy is large", () => {
    const many = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`field${index}`, "y".repeat(300)]),
    );
    expect(storedArguments(many)).toMatchObject({
      $omitted: "arguments",
      keys: expect.arrayContaining(["field0", "field39"]),
    });
  });

  it("keeps a failed call's arguments whole for debugging, up to a cap", () => {
    const args = { name: "report.csv", content: "a,b\n".repeat(100) };
    expect(debugArguments(args)).toEqual(args);
    expect(debugArguments({ content: "z".repeat(70_000) })).toEqual({
      content: { $omitted: "text", chars: 70_000, sha256: expect.any(String) },
    });
  });
});
