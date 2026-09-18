import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Streamdown } from "streamdown";
import { markdownPlugins } from "./markdown-plugins.ts";

// Records the moment @streamdown/mermaid is first imported. Vitest evaluates a
// mock factory on the first import of the module, so a call here means
// something pulled mermaid in, and the whole point of the lazy wrapper is that
// nothing does until a diagram actually renders.
const { mermaidImported } = vi.hoisted(() => ({ mermaidImported: vi.fn() }));
vi.mock("@streamdown/mermaid", async (importOriginal) => {
  mermaidImported();
  return await importOriginal<typeof import("@streamdown/mermaid")>();
});

// jsdom has no IntersectionObserver; streamdown holds a diagram at its
// loading skeleton until it scrolls into view, and without one the mount
// effect throws, tearing the tree down. Kept local, not in tests/setup.ui.ts:
// InfiniteSentinel's button fallback (no observer) is what chats-page tests
// rely on.
globalThis.IntersectionObserver = class IntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as never);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
} as never;

const draw = (markdown: string) =>
  render(<Streamdown plugins={markdownPlugins}>{markdown}</Streamdown>).container;

describe("markdownPlugins", () => {
  it("highlights code with shiki", async () => {
    const container = draw("```ts\nconst x = 1;\n```");
    // Shiki loads its grammar asynchronously; until it lands the fallback
    // leaves every token at `--sdm-c: inherit`, which is what a missing plugin
    // looks like permanently.
    await waitFor(() => {
      const colored = [...container.querySelectorAll<HTMLElement>("[style*='--sdm-c']")];
      expect(colored.length).toBeGreaterThan(0);
      expect(colored.some((el) => !el.style.getPropertyValue("--sdm-c").includes("inherit"))).toBe(
        true,
      );
    });
  });

  it("renders $$…$$ math through katex", () => {
    const container = draw("Einstein said $$E = mc^2$$ once.");
    expect(container.querySelector(".katex")).not.toBeNull();
    // KaTeX emits a pile of markup; this asserts it survives streamdown's
    // rehype-sanitize/rehype-harden pass rather than being stripped.
    expect(container.querySelector(".katex-mathml math")).not.toBeNull();
    expect(container.querySelector("annotation")?.textContent).toBe("E = mc^2");
  });

  it("renders a fenced $$ block as display math", () => {
    const container = draw("Result:\n\n$$\nE = mc^2\n$$\n");
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });

  it("leaves single-dollar amounts alone", () => {
    // Pins the deliberate `singleDollarTextMath: false`: with it enabled this
    // renders as the math expression "5and".
    const container = draw("It costs $5 and $10 total.");
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toBe("It costs $5 and $10 total.");
  });

  it("leaves math inside a code fence unparsed", () => {
    const container = draw("```\n$$E = mc^2$$\n```");
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("$$E = mc^2$$");
  });

  it("ends a CJK autolink before the punctuation that follows it", () => {
    // Without the cjk plugin the trailing "。然后" is swallowed into the URL.
    const container = draw("参见 https://example.com。然后");
    expect(container.querySelector("[data-streamdown='link']")?.textContent).toBe(
      "https://example.com",
    );
    expect(container.textContent).toContain("。然后");
  });

  it("does not load mermaid for markdown without a diagram", () => {
    draw("Just prose with `code` and $$x$$.");
    expect(mermaidImported).not.toHaveBeenCalled();
  });

  it("loads mermaid only once a diagram fence renders", async () => {
    const container = draw("```mermaid\ngraph TD;\n  A-->B;\n```");
    // Routed to the diagram renderer rather than a code block. (The diagram
    // itself needs layout APIs jsdom does not have, so we stop at the import.)
    expect(container.querySelector("[data-streamdown='code-block']")).toBeNull();
    await waitFor(() => expect(mermaidImported).toHaveBeenCalled());
  });
});
