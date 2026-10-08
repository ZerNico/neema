import { describe, expect, it } from "vitest";
import { extractImageQueries, IMAGE_QUERY_LIMITS } from "./extract.ts";

describe("extractImageQueries", () => {
  it("collects literal queries from closed blocks in order, once each", () => {
    const content = [
      "```ui",
      '<image query="7 speed  cassette"/>',
      '{#if open}<images query={["hub gear", `derailleur`]}/>{/if}',
      "```",
      "text",
      "```ui",
      '<image query="hub gear"/>',
      "```",
    ].join("\n");
    expect(extractImageQueries(content)).toEqual(["7 speed cassette", "hub gear", "derailleur"]);
  });

  it("skips computed queries and open fences", () => {
    expect(extractImageQueries('```ui\n<image query={name + " photo"}/>\n```')).toEqual([]);
    expect(extractImageQueries('```ui\n<image query="still streaming"/>')).toEqual([]);
  });

  it("caps queries per answer", () => {
    const tags = Array.from({ length: 12 }, (_, i) => `<image query="q${i}"/>`).join("");
    expect(extractImageQueries(`\`\`\`ui\n${tags}\n\`\`\``)).toHaveLength(
      IMAGE_QUERY_LIMITS.queriesPerAnswer,
    );
  });
});
