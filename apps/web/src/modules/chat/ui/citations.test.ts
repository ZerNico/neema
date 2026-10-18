import { describe, expect, it } from "vitest";
import {
  citedSourceIndexes,
  collectSources,
  prepareCitedMarkdown,
  selectAnswerSources,
} from "./citations.ts";
import { inheritSources } from "./inherited-sources.ts";
import { integrationActivityFromRow } from "../client/tool-families.ts";
import type { ToolActivity, ToolSource } from "../client/use-message-stream.ts";
import { projectIntegrationToolResult } from "~/modules/integrations/tool-schema.ts";
import { toActivity } from "./stored-activities.ts";

const source = (index: number, url: string): ToolSource => ({
  kind: "web" as const,
  index,
  url,
  title: `Title ${index}`,
  snippet: "",
  read: true,
});

const webActivity = (callId: string, sources?: ToolSource[]): ToolActivity => ({
  family: "web",
  callId,
  name: "web_search",
  targets: [],
  status: "complete",
  ...(sources ? { sources } : {}),
});

describe("prepareCitedMarkdown", () => {
  it("leaves content untouched when there are no sources", () => {
    expect(prepareCitedMarkdown("plain [^1] text", [])).toBe("plain [^1] text");
  });

  it("appends a definition per source so markers resolve while streaming", () => {
    const out = prepareCitedMarkdown("Effect 4 is out[^1].", [source(1, "https://effect.website")]);
    expect(out).toContain("Effect 4 is out[^1].");
    expect(out).toContain("[^1]: https://effect.website");
  });

  it("drops a half-streamed trailing marker", () => {
    const out = prepareCitedMarkdown("Released in 2026[^1", [source(1, "https://a.dev")]);
    expect(out).toContain("Released in 2026\n");
    expect(out).not.toContain("2026[^1\n");
  });

  it("closes an unterminated code fence so definitions don't land inside it", () => {
    const out = prepareCitedMarkdown("See[^1]:\n\n```ts\nconst a = 1", [
      source(1, "https://a.dev"),
    ]);
    expect(out).toBe("See[^1]:\n\n```ts\nconst a = 1\n```\n\n[^1]: https://a.dev");
  });

  it("leaves a closed code fence alone", () => {
    const out = prepareCitedMarkdown("```ts\nconst a = 1\n```\nDone[^1].", [
      source(1, "https://a.dev"),
    ]);
    expect(out).toBe("```ts\nconst a = 1\n```\nDone[^1].\n\n[^1]: https://a.dev");
  });

  it("joins adjacent markers into one reference, dropping repeats and unknown indexes", () => {
    const out = prepareCitedMarkdown("Claim[^2][^1] [^2][^9]. Other[^1].", [
      source(1, "https://a.dev"),
      source(2, "https://b.dev"),
    ]);
    expect(out).toContain("Claim[^2-1]. Other[^1].");
    // The group resolves to its first source, so the chip's link needs no lookup.
    expect(out).toContain("[^2-1]: https://b.dev");
    expect(out).toContain("[^1]: https://a.dev");
  });

  it("drops markers with no matching source", () => {
    const out = prepareCitedMarkdown("Claim[^9] and claim[^1].", [source(1, "https://a.dev")]);
    expect(out).toContain("Claim and claim[^1].");
  });
});

describe("answer evidence selection", () => {
  it("includes own cited or extracted evidence and only cited inherited evidence", () => {
    const own = [
      source(1, "https://a.dev"),
      { ...source(2, "https://b.dev"), read: false },
      { ...source(3, "https://c.dev"), read: false },
    ];
    const inherited = inheritSources([
      [source(4, "https://d.dev"), source(5, "https://e.dev")],
      [],
    ])[1]!;
    expect(
      selectAnswerSources("Claim[^2] and prior finding[^4].", own, inherited).map((s) => s.index),
    ).toEqual([1, 2, 4]);
    expect(selectAnswerSources("No cited evidence.", [own[1]!], inherited)).toEqual([]);
  });

  it.each([
    "`[^2]`",
    "`` example ` [^2] ``",
    "```md\n[^2]\n```",
    "~~~md\n[^2]\n~~~",
    "    [^2]",
    "> ```md\n> [^2]\n> ```",
    "[^2]: definition containing [^3]",
    "\\[^2]",
    "```md\nunterminated [^2]",
  ])("does not count example code or definitions as citations: %s", (example) => {
    expect([...citedSourceIndexes(`Claim[^1].\n\n${example}`)]).toEqual([1]);
  });

  it("counts prose in blockquotes/lists and ignores half-streamed markers", () => {
    expect([...citedSourceIndexes("> Claim[^2]\n\n- Another[^3]\n\nHalf[^4")]).toEqual([2, 3]);
  });
});

const integrationProjection = (read = true) =>
  projectIntegrationToolResult({
    name: "int_outline__search_documents",
    integrationId: "outline",
    tool: "search_documents",
    label: "Search documents",
    access: "read",
    summary: null,
    raw: { ok: true },
    isFailure: false,
    sources: [
      {
        kind: "integration",
        index: 2,
        integrationId: "outline",
        url: "https://outline.test/document",
        title: "Service document",
        snippet: "",
        read,
      },
    ],
  });

const storedIntegration = (id: string, read = true) =>
  toActivity({
    id,
    toolName: "int_outline__search_documents",
    arguments: {},
    result: integrationProjection(read),
    status: "complete",
    turnIndex: 0,
    callIndex: 0,
    textOffset: 0,
    error: null,
  });

describe("integration citation projections", () => {
  it.each(["live", "reload", "branch"])("resolves integration-only citations on %s", (path) => {
    // Branches copy the durable projection with a fresh row id.
    const activity =
      path === "live"
        ? integrationActivityFromRow("live-call", integrationProjection())
        : storedIntegration(path === "reload" ? "stored-call" : "branched-call");
    const own = collectSources([activity]);
    expect(own.map((item) => item.index)).toEqual([2]);
    const selected = selectAnswerSources("Claim[^2].", own, () => undefined);
    expect(prepareCitedMarkdown("Claim[^2].", selected)).toBe(
      "Claim[^2].\n\n[^2]: https://outline.test/document",
    );
  });

  it("merges integration with web evidence by numeric index without dropping markers", () => {
    const own = collectSources([
      storedIntegration("first"),
      webActivity("web", [source(1, "https://web.test/page")]),
      storedIntegration("duplicate"),
    ]);
    expect(own.map((item) => item.index)).toEqual([1, 2]);
    const selected = selectAnswerSources("Web[^1]. Service[^2].", own, () => undefined);
    const markdown = prepareCitedMarkdown("Web[^1]. Service[^2].", selected);
    expect(markdown).toContain("Web[^1]. Service[^2].");
    expect(markdown).toContain("[^1]: https://web.test/page");
    expect(markdown).toContain("[^2]: https://outline.test/document");
  });

  it("inherits integration evidence only when cited on a subsequent turn", () => {
    const own = collectSources([storedIntegration("earlier")]);
    const inherited = inheritSources([own, []])[1]!;
    const selected = selectAnswerSources("Prior finding[^2].", [], inherited);
    expect(selected.map((item) => item.index)).toEqual([2]);
    expect(prepareCitedMarkdown("Prior finding[^2].", selected)).toContain(
      "[^2]: https://outline.test/document",
    );
    expect(selectAnswerSources("No earlier citations.", [], inherited)).toEqual([]);
  });

  it("keeps read evidence and requires citations for snippet-only integration sources", () => {
    expect(
      selectAnswerSources(
        "No citation.",
        collectSources([storedIntegration("read")]),
        () => undefined,
      ),
    ).toHaveLength(1);
    const snippet = collectSources([storedIntegration("snippet", false)]);
    expect(selectAnswerSources("No citation.", snippet, () => undefined)).toEqual([]);
    expect(selectAnswerSources("Claim[^2].", snippet, () => undefined)).toHaveLength(1);
  });
});

describe("collectSources", () => {
  it("merges web activities, dedupes by index and sorts", () => {
    const merged = collectSources([
      webActivity("one", [source(2, "https://b.dev"), source(1, "https://a.dev")]),
      webActivity("two", [source(2, "https://b.dev"), source(3, "https://c.dev")]),
      webActivity("three"),
    ]);
    expect(merged.map((s) => s.index)).toEqual([1, 2, 3]);
  });

  it("ignores memory activities even if malformed input carries sources", () => {
    const malformedMemory = {
      family: "memory",
      callId: "memory-1",
      name: "save_memory",
      status: "complete",
      outcome: "created",
      sources: [source(9, "https://should-never-appear.dev")],
    } as ToolActivity;

    expect(
      collectSources([malformedMemory, webActivity("web", [source(1, "https://a.dev")])]),
    ).toEqual([source(1, "https://a.dev")]);
  });
});

describe("prepareCitedMarkdown next to ui blocks", () => {
  it("rewrites markers in prose but not inside a ui block", () => {
    const block = "```ui key=0\n<text>see [^1][^9]</text>\n```";
    const out = prepareCitedMarkdown(`A[^1][^9].\n\n${block}\n`, [
      { kind: "web", index: 1, url: "https://a.dev", title: "A", snippet: "", read: false },
    ]);
    expect(out.startsWith(`A[^1].\n\n${block}\n`)).toBe(true);
  });
});
