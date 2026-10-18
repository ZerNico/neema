import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ActivateWorkTurnInput,
  AnswerQuestionInput,
  EditMessageInput,
  QueueMessageInput,
  RetryMessageInput,
  SendMessageInput,
} from "./schema.ts";

const generation = {
  modelId: "m1",
  content: "hello",
  searchEnabled: false,
  researchEnabled: false,
  attachmentIds: [],
};

it("accepts a structured edit without prose and rejects mixed edit payloads", () => {
  const decode = Schema.decodeUnknownSync(EditMessageInput);
  const input = {
    conversationId: "c1",
    messageId: "u1",
    modelId: "m1",
    searchEnabled: false,
    researchEnabled: false,
    attachmentIds: [],
    questionResponse: { kind: "skip" },
  };
  expect(decode(input)).toEqual(input);
  expect(() => decode({ ...input, content: "arbitrary prose" })).toThrow(
    /Expected never\n  at \["content"\]/,
  );
  expect(() => decode({ ...input, questionResponse: { kind: "answers", answers: [] } })).toThrow(
    /Expected a value with a length of at least 1\n  at \["questionResponse"\]\["answers"\]/,
  );
});

it("accepts supported reasoning efforts and defaults across submissions", () => {
  const id = "01990f4e-6650-7a33-a768-611e2e4bf4c7";
  const send = { conversation: { kind: "new", id, mode: "chat" }, ...generation };
  const work = { ...send, reservationId: id, workspaceFiles: ["notes.txt"] };
  const answer = {
    conversationId: "c1",
    callId: "call1",
    response: { kind: "skip" },
    modelId: "m1",
    searchEnabled: false,
    researchEnabled: false,
  };
  const edit = { conversationId: "c1", messageId: "u1", ...generation };
  const structuredEdit = {
    conversationId: "c1",
    messageId: "u1",
    modelId: "m1",
    searchEnabled: false,
    researchEnabled: false,
    attachmentIds: [],
    questionResponse: { kind: "skip" },
  };
  const queue = { conversationId: "c1", ...generation };
  for (const [schema, input] of [
    [SendMessageInput, send],
    [ActivateWorkTurnInput, work],
    [AnswerQuestionInput, answer],
    [EditMessageInput, edit],
    [EditMessageInput, structuredEdit],
    [QueueMessageInput, queue],
  ] as const) {
    const decode = Schema.decodeUnknownSync(schema);
    expect(decode(input)).not.toHaveProperty("reasoningEffort");
    expect(decode({ ...input, reasoningEffort: null })).toHaveProperty("reasoningEffort", null);
    expect(decode({ ...input, reasoningEffort: "high" })).toHaveProperty("reasoningEffort", "high");
    expect(() => decode({ ...input, reasoningEffort: "unsupported" })).toThrow(
      /\n  at \["reasoningEffort"\]$/,
    );
  }
});

for (const [name, schema, input] of [
  [
    "send",
    SendMessageInput,
    {
      conversation: {
        kind: "new",
        id: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
        mode: "chat",
      },
      ...generation,
    },
  ],
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
      expect(() => decode({ ...input, timeZone: "x".repeat(101) })).toThrow(
        'Expected a value with a length of at most 100\n  at ["timeZone"]',
      );
      expect(() => decode({ ...input, timeZone: 42 })).toThrow(
        'Expected string\n  at ["timeZone"]',
      );
    });
  });
}
