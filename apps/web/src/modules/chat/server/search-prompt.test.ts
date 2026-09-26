import { describe, expect, it } from "@effect/vitest";
import { Prompt } from "effect/unstable/ai";
import {
  buildSearchReminder,
  type CitableSource,
  webToolsSystemHint,
  systemReminderMessage,
  withSearchReminder,
} from "./search-prompt.ts";

const source = (
  index: number,
  overrides: Partial<Extract<CitableSource, { readonly kind: "web" }>> = {},
): CitableSource => ({
  kind: "web" as const,
  index,
  url: `https://example.com/${index}`,
  title: `Result ${index}`,
  snippet: `Snippet ${index}`,
  ...overrides,
});

const textOf = (message: Prompt.Message): string =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
        .join("");

describe("webToolsSystemHint", () => {
  it("does not direct search-only requests to an unavailable reader", () => {
    const hint = webToolsSystemHint({ search: true, reader: false });
    expect(hint).toContain("Use web_search");
    expect(hint).toContain("returns snippets only, not page content");
    expect(hint).not.toContain("read_url");
  });

  it("limits read_url to user and search-result URLs", () => {
    const hint = webToolsSystemHint({ search: false, reader: true });
    expect(hint).toContain("URLs from user messages and web_search results");
    expect(hint).toContain("Never invent a URL");
    expect(hint).toContain("one or more HTTP(S) URLs in a single call");
    expect(hint).not.toContain("Use web_search to look up");
  });

  it("defaults to one focused query and reserves multi-query search for broad requests", () => {
    const hint = webToolsSystemHint({ search: true, reader: true });
    expect(hint).toContain("returns snippets only, not page content");
    expect(hint).toContain("Start with one focused query");
    expect(hint).toContain("Use several queries in one call only when");
    expect(hint).toContain("broad, ambiguous, comparative, or genuinely multi-part");
    expect(hint).toContain("use read_url to open the most relevant results");
  });
});

describe("buildSearchReminder", () => {
  it("lists prior sources by index with their url and snippet", () => {
    const text = buildSearchReminder({ sources: [source(1), source(4)], lastCycle: false });
    expect(text).toContain("[1] Result 1: https://example.com/1");
    expect(text).toContain("Snippet 1");
    expect(text).toContain("[4] Result 4: https://example.com/4");
  });

  it("omits the snippet line for a source that has none", () => {
    const text = buildSearchReminder({ sources: [source(2, { snippet: "" })], lastCycle: false });
    expect(text).toContain("[2] Result 2: https://example.com/2");
    expect(text).not.toContain("    ");
  });

  it("still reminds about citations when nothing was consulted yet", () => {
    const text = buildSearchReminder({ sources: [], lastCycle: false });
    expect(text).not.toContain("already consulted");
    expect(text).toContain("cite inline");
  });

  it("announces the last cycle ahead of the citation reminder", () => {
    const text = buildSearchReminder({ sources: [], lastCycle: true });
    expect(text).toContain("no tool calls left");
    expect(text.indexOf("no tool calls left")).toBeLessThan(text.indexOf("cite inline"));
  });

  it("keeps the last-cycle line out of every other round", () => {
    expect(buildSearchReminder({ sources: [source(1)], lastCycle: false })).not.toContain(
      "no tool calls left",
    );
  });
});

describe("systemReminderMessage", () => {
  it("wraps the text in tags on a user message, since chat APIs have no reminder role", () => {
    const message = systemReminderMessage("stay on topic");
    expect(message.role).toBe("user");
    expect(message.content).toBe("<system-reminder>\nstay on topic\n</system-reminder>");
  });
});

describe("withSearchReminder", () => {
  const transcript = Prompt.make([
    { role: "system" as const, content: webToolsSystemHint({ search: true, reader: false }) },
    { role: "user" as const, content: "what changed last week?" },
  ]);

  it("appends the reminder last, behind the whole transcript", () => {
    const prompt = withSearchReminder(transcript, { sources: [source(1)], lastCycle: false });
    expect(prompt.content).toHaveLength(transcript.content.length + 1);
    expect(textOf(prompt.content.at(-1)!)).toContain("<system-reminder>");
    expect(prompt.content.at(-1)!.role).toBe("user");
  });

  it("leaves the prefix byte-identical as the transcript grows, so caches keep matching", () => {
    const first = withSearchReminder(transcript, { sources: [], lastCycle: false });
    // A tool round later: results appended, reminder rebuilt against the
    // transcript that never carried the previous one.
    const grown = Prompt.concat(
      transcript,
      Prompt.make([{ role: "assistant" as const, content: "searching…" }]),
    );
    const second = withSearchReminder(grown, { sources: [source(1)], lastCycle: true });

    expect(second.content.slice(0, transcript.content.length)).toEqual(
      first.content.slice(0, transcript.content.length),
    );
    // The stale reminder is gone, not buried mid-transcript.
    // startsWith, not includes: the system hint mentions the tag by name.
    const reminders = second.content.filter((m) => textOf(m).startsWith("<system-reminder>"));
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toBe(second.content.at(-1));
  });
});
