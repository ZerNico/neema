import { describe, expect, it } from "vitest";
import type { WebSource } from "~/modules/tools/schema.ts";
import {
  boundEvidence,
  boundedSourceManifest,
  evidenceManifest,
  evidenceTokens,
} from "./evidence.ts";

const sources: WebSource[] = Array.from({ length: 12 }, (_, i) => ({
  kind: "web" as const,
  index: i + 1,
  url: `https://evidence.example/${i + 1}`,
  title: `Source ${i + 1}`,
  snippet: "",
  read: i % 2 === 0,
}));

describe("bounded research evidence", () => {
  it("includes only metadata supporting retained handles or exact URLs", () => {
    const manifest = evidenceManifest(
      "Claim [^1], contrast [2], https://evidence.example/3",
      sources,
    );
    expect(manifest).toContain("[1] Source 1");
    expect(manifest).toContain("[2] Source 2");
    expect(manifest).toContain("[3] Source 3");
    expect(manifest).not.toContain("[4]");
    expect(manifest).toContain("page extracted");
    expect(manifest).toContain("snippet only");
  });

  it.each([0, 8, 32, 128, 512])(
    "bounds the entire manifest including omission notices to %i tokens",
    (maxTokens) => {
      const text = boundedSourceManifest(
        [
          ...sources,
          {
            ...sources[0]!,
            index: 20,
            title: "long".repeat(4000),
            url: `https://long.example/${"x".repeat(4000)}`,
          },
        ],
        maxTokens,
      );
      if (text) expect(evidenceTokens(text)).toBeLessThanOrEqual(maxTokens);
      if (text && !text.includes("[20]")) expect(text).toContain("metadata omitted");
    },
  );

  it("preserves every task and its source in a bounded deterministic fallback", () => {
    const blocks = sources.map((source) => ({
      label: `Task ${source.index}`,
      text: `Finding [^${source.index}] ${"supporting detail ".repeat(1000)} Unresolved disagreement [${source.index}].`,
    }));
    const result = boundEvidence(blocks, sources, 1800);
    expect(result.abridged).toBe(true);
    expect(evidenceTokens(result.text)).toBeLessThanOrEqual(1800);
    for (const source of sources) {
      expect(result.text).toContain(`Task ${source.index}\nFinding [^${source.index}]`);
      expect(result.text).toContain(source.url);
    }
    expect(result.text).toContain("Evidence abridged");
    expect(result).toEqual(boundEvidence(blocks, sources, 1800));
  });

  it("does not silently turn omitted reports into empty task labels", () => {
    const blocks = [{ label: "Task", text: "Evidence ".repeat(1000) }];
    const result = boundEvidence(blocks, sources, 30);
    expect(result.abridged).toBe(true);
    expect(result.text).toContain("omitted");
    expect(evidenceTokens(result.text)).toBeLessThanOrEqual(30);
    expect(boundEvidence(blocks, sources, 1)).toEqual({ text: "", abridged: true });
  });

  it("does not truncate evidence or expand its manifest when it already fits", () => {
    const result = boundEvidence([{ label: "Task", text: "Finding [^1]." }], sources, 1000);
    expect(result.abridged).toBe(false);
    expect(result.text).toContain("Finding [^1].");
    expect(result.text).not.toContain("Source 2");
  });
});
