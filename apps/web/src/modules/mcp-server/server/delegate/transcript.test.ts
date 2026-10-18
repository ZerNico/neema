import { describe, expect, it } from "vitest";
import type { Source } from "~/modules/tools/source-schema.ts";
import { renderTranscript, type TranscriptInput } from "./transcript.ts";

const at = new Date("2026-10-17T10:00:00.000Z");
const message = (
  fields: Partial<TranscriptInput["messages"][number]> & { id: string; role: "user" | "assistant" },
): TranscriptInput["messages"][number] => ({
  content: "",
  status: "complete",
  error: null,
  createdAt: at,
  generationId: null,
  originClientName: null,
  questionResponse: null,
  steeredIntoMessageId: null,
  ...fields,
});
const web = (index: number, title: string): Source => ({
  kind: "web",
  index,
  title,
  snippet: "",
  read: true,
  url: `https://example.com/${index}`,
});

describe("renderTranscript", () => {
  it("resolves a citation to a source an earlier answer found", () => {
    const text = renderTranscript({
      messages: [
        message({ id: "u1", role: "user", content: "Look it up", originClientName: "Claude" }),
        message({ id: "a1", role: "assistant", content: "Found it.[^1]" }),
        message({ id: "u2", role: "user", content: "And again?" }),
        message({ id: "a2", role: "assistant", content: "As before.[^1]", status: "aborted" }),
      ],
      toolCalls: [
        {
          messageId: "a1",
          toolName: "web_search",
          arguments: {},
          researchRunId: null,
          result: { sources: [web(1, "First page")] },
        },
      ],
      attachments: [{ messageId: "u2", fileName: "notes.pdf" }],
      priorSources: [],
      origin: "https://chat.example",
    });
    expect(text).toContain("### Person (via Claude)");
    expect(text).toContain("_Tools: web_search_");
    expect(text).toContain("_Files: notes.pdf_");
    expect(text).toContain("_(stopped before it finished)_");
    // Defined under both answers: each footnote block stands on its own.
    expect(text.match(/\[\^1\]: \[First page\]\(<https:\/\/example\.com\/1>\)/g)).toHaveLength(2);
  });

  it("never backs an earlier answer with a source a later one found", () => {
    const text = renderTranscript({
      messages: [
        message({ id: "a1", role: "assistant", content: "Claimed.[^1]" }),
        message({ id: "a2", role: "assistant", content: "Searched.[^1]" }),
      ],
      toolCalls: [
        {
          messageId: "a2",
          toolName: "web_search",
          arguments: {},
          researchRunId: null,
          result: { sources: [web(1, "Late")] },
        },
      ],
      attachments: [],
      priorSources: [],
      origin: "https://chat.example",
    });
    expect(text.match(/\[\^1\]: \[Late\]/g)).toHaveLength(1);
    expect(text.indexOf("[^1]: [Late]")).toBeGreaterThan(text.indexOf("Searched."));
  });

  it("cites a source registered before the page from the prior sources", () => {
    const text = renderTranscript({
      messages: [message({ id: "a", role: "assistant", content: "See [^4]." })],
      toolCalls: [],
      attachments: [],
      priorSources: [web(4, "Old")],
      origin: "https://chat.example",
    });
    expect(text).toContain("[^4]: [Old](<https://example.com/4>)");
  });

  it("lists a research run's own calls once, under the call that started it", () => {
    const call = (toolName: string, researchRunId: string | null) => ({
      messageId: "a",
      toolName,
      arguments: {},
      researchRunId,
      result: null,
    });
    const text = renderTranscript({
      messages: [message({ id: "a", role: "assistant", content: "Report." })],
      toolCalls: [
        call("deep_research", null),
        call("web_search", "run-1"),
        call("web_search", "run-1"),
      ],
      attachments: [],
      priorSources: [],
      origin: "https://chat.example",
    });
    expect(text).toContain("_Tools: deep_research_");
    expect(text).not.toContain("web_search");
  });
});
