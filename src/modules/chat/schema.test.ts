import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { EditMessageInput, RetryMessageInput, SendMessageInput } from "./schema.ts";

const generation = { modelId: "m1", content: "hello", searchEnabled: false, attachmentIds: [] };

for (const [name, schema, input] of [
  ["send", SendMessageInput, { conversationId: null, ...generation }],
  ["retry", RetryMessageInput, { conversationId: "c1", messageId: "m1" }],
  ["edit", EditMessageInput, { conversationId: "c1", messageId: "m1", ...generation }],
] as const) {
  describe(`${name} timezone input`, () => {
    const decode = Schema.decodeUnknownSync(schema);

    it("preserves the optional browser timezone and accepts older clients", () => {
      expect(decode({ ...input, timeZone: "Europe/Berlin" })).toMatchObject({
        timeZone: "Europe/Berlin",
      });
      expect(decode(input)).not.toHaveProperty("timeZone");
    });

    it("bounds client metadata and rejects non-string values", () => {
      expect(() => decode({ ...input, timeZone: "x".repeat(101) })).toThrow();
      expect(() => decode({ ...input, timeZone: 42 })).toThrow();
    });
  });
}
