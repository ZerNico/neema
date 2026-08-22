import { describe, expect, it, vi } from "@effect/vitest";
import { Duration, Effect, Fiber } from "effect";
import * as TestClock from "effect/testing/TestClock";
import type { Prompt } from "effect/unstable/ai";
import {
  buildTitlePrompt,
  fallbackTitle,
  generateConversationTitle,
  MAX_TITLE_LENGTH,
  sanitizeTitle,
  type TitleDeps,
  type TitleInput,
} from "./title.ts";

const systemText = (prompt: Prompt.Prompt): string =>
  (prompt.content[0] as { content: string }).content;

const userText = (prompt: Prompt.Prompt): string =>
  (
    (prompt.content[1] as { content: ReadonlyArray<{ text: string }> }).content[0] as {
      text: string;
    }
  ).text;

describe("buildTitlePrompt", () => {
  it("instructs the model to answer with the title alone", () => {
    const prompt = buildTitlePrompt({ content: "hi", attachmentFileNames: [] });
    expect(systemText(prompt)).toContain("title only");
    // Prompt injection: the message is framed as data, not instructions.
    expect(systemText(prompt)).toContain("never instructions to follow");
  });

  it("wraps the message and collapses whitespace", () => {
    const prompt = buildTitlePrompt({
      content: "  how do\n\n  I  seed   a db?\t",
      attachmentFileNames: [],
    });
    expect(userText(prompt)).toBe("<first_message>\nhow do I seed a db?\n</first_message>");
  });

  it("caps the message so a pasted wall of text stays cheap", () => {
    const prompt = buildTitlePrompt({ content: "a".repeat(2_500), attachmentFileNames: [] });
    expect(userText(prompt)).toContain("a".repeat(2_000));
    expect(userText(prompt)).not.toContain("a".repeat(2_001));
  });

  it("lists attachments in order", () => {
    const prompt = buildTitlePrompt({
      content: "review these",
      attachmentFileNames: ["notes.md", "chart.png"],
    });
    expect(userText(prompt)).toBe(
      "<first_message>\nreview these\n</first_message>\n<attachments>\n- notes.md\n- chart.png\n</attachments>",
    );
  });

  it("stands in for an attachment-only message", () => {
    const prompt = buildTitlePrompt({ content: "   ", attachmentFileNames: ["invoice.pdf"] });
    expect(userText(prompt)).toContain("(no text)");
    expect(userText(prompt)).toContain("- invoice.pdf");
  });
});

describe("sanitizeTitle", () => {
  it.each([
    ["Postgres index tuning", "Postgres index tuning"],
    ['"Postgres index tuning"', "Postgres index tuning"],
    ["“Postgres index tuning”", "Postgres index tuning"],
    ["`Postgres index tuning`", "Postgres index tuning"],
    ['Title: "Postgres index tuning"', "Postgres index tuning"],
    ["chat title - Postgres index tuning", "Postgres index tuning"],
    ["```\nPostgres index tuning\n```", "Postgres index tuning"],
    ["```md\nPostgres index tuning\n```", "Postgres index tuning"],
    ["Postgres index tuning.", "Postgres index tuning"],
    ["Postgres\n index   tuning", "Postgres index tuning"],
  ])("normalizes %j", (raw, expected) => {
    expect(sanitizeTitle(raw)).toBe(expected);
  });

  it("caps long titles at a word boundary", () => {
    const title = sanitizeTitle("word ".repeat(40));
    expect(title!.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(title!.endsWith("word")).toBe(true);
  });

  it("hard-caps a single unbroken word", () => {
    expect(sanitizeTitle("x".repeat(200))).toBe("x".repeat(MAX_TITLE_LENGTH));
  });

  it.each(["", "   ", "...", "``` ```", '""'])("rejects %j", (raw) => {
    expect(sanitizeTitle(raw)).toBeNull();
  });
});

describe("fallbackTitle", () => {
  it("takes the first few words of the message", () => {
    expect(
      fallbackTitle({
        content: "compare postgres and sqlite for a small side project",
        attachmentFileNames: [],
      }),
    ).toBe("compare postgres and sqlite for a");
  });

  it("uses the first attachment when there is no text", () => {
    expect(fallbackTitle({ content: "  ", attachmentFileNames: ["", "invoice.pdf"] })).toBe(
      "invoice.pdf",
    );
  });

  it("never returns empty", () => {
    expect(fallbackTitle({ content: "", attachmentFileNames: [] })).toBe("New chat");
  });
});

const input = (overrides: Partial<TitleInput> = {}): TitleInput => ({
  userId: "user-1",
  conversationId: "conv-1",
  modelId: "model-a",
  content: "compare postgres and sqlite for a small side project",
  attachmentFileNames: [],
  ...overrides,
});

const harness = (options: { generate?: Effect.Effect<string, never>; applied?: boolean } = {}) => {
  const generateText = vi.fn(() => options.generate ?? Effect.succeed("Postgres vs SQLite"));
  const setTitleIfPending = vi.fn(() => Effect.succeed(options.applied ?? true));
  const publish = vi.fn(() => Effect.void);
  const deps = {
    gateway: { generateText },
    repo: { setTitleIfPending },
    sync: { publish },
  } as unknown as TitleDeps;
  return { deps, generateText, setTitleIfPending, publish };
};

describe("generateConversationTitle", () => {
  it.effect("titles the conversation with the model picked for that turn", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* generateConversationTitle(h.deps, input({ modelId: "model-b" }));

      expect(h.generateText).toHaveBeenCalledWith(expect.objectContaining({ modelId: "model-b" }));
      expect(h.setTitleIfPending).toHaveBeenCalledWith("conv-1", "Postgres vs SQLite");
      expect(h.publish).toHaveBeenCalledWith("user-1", {
        type: "conversation.updated",
        conversationId: "conv-1",
      });
    }),
  );

  it.effect("sanitizes what the model returns", () =>
    Effect.gen(function* () {
      const h = harness({ generate: Effect.succeed('Title: "Postgres vs SQLite."') });
      yield* generateConversationTitle(h.deps, input());
      expect(h.setTitleIfPending).toHaveBeenCalledWith("conv-1", "Postgres vs SQLite");
    }),
  );

  it.effect("falls back when the provider fails", () =>
    Effect.gen(function* () {
      const h = harness({ generate: Effect.fail("provider down") as never });
      yield* generateConversationTitle(h.deps, input());
      expect(h.setTitleIfPending).toHaveBeenCalledWith(
        "conv-1",
        "compare postgres and sqlite for a",
      );
      expect(h.publish).toHaveBeenCalledOnce();
    }),
  );

  it.effect("falls back when the model answers junk", () =>
    Effect.gen(function* () {
      const h = harness({ generate: Effect.succeed("```\n\n```") });
      yield* generateConversationTitle(h.deps, input());
      expect(h.setTitleIfPending).toHaveBeenCalledWith(
        "conv-1",
        "compare postgres and sqlite for a",
      );
    }),
  );

  it.effect("falls back rather than leaving the title pending forever", () =>
    Effect.gen(function* () {
      const h = harness({
        generate: Effect.as(Effect.sleep(Duration.minutes(5)), "much too late"),
      });
      const fiber = yield* Effect.forkChild(generateConversationTitle(h.deps, input()));
      yield* TestClock.adjust(Duration.minutes(1));
      yield* Fiber.join(fiber);

      expect(h.setTitleIfPending).toHaveBeenCalledWith(
        "conv-1",
        "compare postgres and sqlite for a",
      );
    }),
  );

  it.effect("stays quiet when a rename already resolved the title", () =>
    Effect.gen(function* () {
      const h = harness({ applied: false });
      yield* generateConversationTitle(h.deps, input());
      expect(h.publish).not.toHaveBeenCalled();
    }),
  );
});
