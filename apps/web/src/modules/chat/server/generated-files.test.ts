import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { decodeGeneratedImage } from "./generated-files.ts";
import { ASSISTANT_FILE_LIMITS } from "../assistant-output.ts";

const png = (size: number) => {
  const bytes = Buffer.alloc(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  return bytes;
};
describe("generated image validation", () => {
  for (const size of [8 * 1024 * 1024, ASSISTANT_FILE_LIMITS.bytes]) {
    it.effect(`accepts bounded ${size}-byte base64 without recursive regex overflow`, () =>
      Effect.gen(function* () {
        const bytes = png(size);
        const decoded = yield* decodeGeneratedImage("image/png", bytes.toString("base64"));
        expect(Buffer.from(decoded).equals(bytes)).toBe(true);
      }),
    );
  }
  for (const data of [
    "https://example.com/image.png",
    "data:image/png;base64,AAAA",
    "A===",
    "AA=A",
    "AAAA\n",
    "AAAAA",
    "!!!!",
  ]) {
    it.effect(`rejects invalid input ${JSON.stringify(data)}`, () =>
      Effect.gen(function* () {
        expect((yield* Effect.result(decodeGeneratedImage("image/png", data)))._tag).toBe(
          "Failure",
        );
      }),
    );
  }
  it.effect("rejects mismatched and unsupported media and oversized bytes", () =>
    Effect.gen(function* () {
      for (const [media, data] of [
        ["image/jpeg", png(20)],
        ["image/svg+xml", png(20)],
        ["image/png", png(ASSISTANT_FILE_LIMITS.bytes + 1)],
      ] as const) {
        expect((yield* Effect.result(decodeGeneratedImage(media, data)))._tag).toBe("Failure");
      }
    }),
  );
});
