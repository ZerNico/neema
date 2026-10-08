import { describe, expect, it } from "vitest";
import { answerExcerpt } from "./excerpt.ts";

describe("answerExcerpt", () => {
  it("keeps the words of markdown and drops its marks and citations", () => {
    expect(
      answerExcerpt(
        "## Today\n\n- **Rain** after 3pm[^2], see [the forecast](https://x.test)\n- `umbrella`",
      ),
    ).toBe("Today Rain after 3pm, see the forecast umbrella");
  });

  it("cuts a long answer at a word and marks the cut", () => {
    const excerpt = answerExcerpt("word ".repeat(100), 30);
    expect(excerpt.length).toBeLessThanOrEqual(31);
    expect(excerpt.endsWith("word…")).toBe(true);
  });
});
