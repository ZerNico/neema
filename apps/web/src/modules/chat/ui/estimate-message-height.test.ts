import { describe, expect, it } from "vitest";
import { estimateMessageHeight } from "./estimate-message-height.ts";
import type { DisplayMessage } from "./message-list.tsx";

const message = (role: DisplayMessage["role"], content: string): DisplayMessage => ({
  id: "m",
  role,
  content,
  reasoning: "",
  reasoningSeen: false,
  toolActivities: [],
  status: "complete",
});
const words = (count: number) => Array.from({ length: count }, () => "word").join(" ");

/** An answer that is one code block of `lines` lines. */
const code = (lines: number) => message("assistant", `\`\`\`ts\n${"x();\n".repeat(lines)}\`\`\``);

// Heights read from the rendered transcript at a 768px column.
describe("estimateMessageHeight", () => {
  it("matches a measured question and answer", () => {
    expect(estimateMessageHeight(message("user", words(20)), 768)).toBeCloseTo(121.5, 0);
    const answer = `## Heading\n\n${words(23)}\n\n${words(23)}`;
    expect(estimateMessageHeight(message("assistant", answer), 768)).toBeCloseTo(203, -1);
  });

  it("grows as text wraps in a narrower column", () => {
    const long = message("assistant", words(200));
    expect(estimateMessageHeight(long, 400)).toBeGreaterThan(estimateMessageHeight(long, 768));
  });

  it("stops a long code block at the height Streamdown caps it to", () => {
    expect(estimateMessageHeight(code(30), 768)).toBe(estimateMessageHeight(code(300), 768));
    expect(estimateMessageHeight(code(3), 768)).toBeLessThan(estimateMessageHeight(code(30), 768));
  });

  it("counts link text, not link targets", () => {
    const link = `[docs](https://example.com/${"x".repeat(400)})`;
    expect(estimateMessageHeight(message("assistant", link), 768)).toBe(
      estimateMessageHeight(message("assistant", "docs"), 768),
    );
  });

  it("adds room for tool rows, reasoning and a day heading", () => {
    const plain = message("assistant", "Answer.");
    const busy = {
      ...plain,
      reasoningSeen: true,
      dayLabel: "Today",
      toolActivities: [{ callId: "c" } as DisplayMessage["toolActivities"][number]],
    };
    expect(estimateMessageHeight(busy, 768)).toBeGreaterThan(
      estimateMessageHeight(plain, 768) + 100,
    );
  });
});
