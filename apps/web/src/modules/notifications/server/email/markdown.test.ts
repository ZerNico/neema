import { describe, expect, it } from "vitest";
import { answerHtml } from "./markdown.ts";

describe("answerHtml", () => {
  it("shows the model's markup as text, never as markup", () => {
    const { html } = answerHtml(
      'Hi <b onclick="x()">there</b>\n\n<script>alert(1)</script>\n\n![x](https://e.test/a.png)',
    );
    expect(html).not.toMatch(/<(script|b|img)\b/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b onclick=&quot;x()&quot;&gt;");
  });

  it("keeps web and mail links only", () => {
    const { html } = answerHtml(
      "[ok](https://e.test/a?b=1&c=2) [mail](mailto:a@e.test) [bad](javascript:alert(1)) [app](/chat/x)",
    );
    expect(html).toContain('href="https://e.test/a?b=1&amp;c=2"');
    expect(html).toContain('href="mailto:a@e.test"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain('href="/chat');
    expect(html).toContain("bad");
  });

  it("drops citation markers, their sources and ui blocks", () => {
    const { html } = answerHtml(
      "Rates held[^1].\n\n```ui\nbutton\n```\n\n[^1]: https://e.test/source",
    );
    expect(html).toContain("Rates held.");
    expect(html).not.toContain("[^1]");
    expect(html).not.toContain("e.test/source");
    expect(html).not.toContain("button");
  });

  it("cuts between blocks and says so", () => {
    const block = "word ".repeat(60);
    const { html, truncated } = answerHtml(
      Array.from({ length: 8 }, (_, i) => `## Part ${i}\n\n${block}`).join("\n\n"),
    );
    expect(truncated).toBe(true);
    expect(html).toContain("Part 0");
    expect(html).not.toContain("Part 7");
    expect(answerHtml("Short answer.")).toMatchObject({ truncated: false });
  });

  it("falls back to plain words when one block is far past the limit", () => {
    const { html, truncated } = answerHtml(`| a |\n| - |\n${"| cell |\n".repeat(2000)}`);
    expect(truncated).toBe(true);
    expect(html).not.toContain("<table");
    expect(html.length).toBeLessThan(2000);
  });
});
