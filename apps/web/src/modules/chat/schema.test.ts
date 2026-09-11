import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { EditMessageInput, RetryMessageInput, SendMessageInput } from "./schema.ts";

const generation = { modelId: "m1", content: "hello", searchEnabled: false, attachmentIds: [] };

it("accepts a structured edit without prose and rejects mixed edit payloads", () => {
  const decode = Schema.decodeUnknownSync(EditMessageInput);
  const input = {
    conversationId: "c1",
    messageId: "u1",
    modelId: "m1",
    searchEnabled: false,
    attachmentIds: [],
    questionResponse: { kind: "skip" },
  };
  expect(decode(input)).toEqual(input);
  expect(() => decode({ ...input, content: "arbitrary prose" })).toThrow();
  expect(() => decode({ ...input, questionResponse: { kind: "answers", answers: [] } })).toThrow();
});

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
