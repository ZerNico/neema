import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CodeViewer } from "./code-viewer.tsx";

const tokensOf = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>("[data-shiki-token]"),
];

describe("CodeViewer", () => {
  it("numbers every line, including blank ones", () => {
    const { container } = render(<CodeViewer text={"a\n\nb"} language="" />);
    const gutter = [...container.querySelectorAll("[aria-hidden]")].map((el) => el.textContent);
    expect(gutter).toEqual(["1", "2", "3"]);
  });

  it("does not invent a line for a trailing newline", () => {
    const { container } = render(<CodeViewer text={"only\n"} language="" />);
    expect(container.querySelectorAll("[aria-hidden]")).toHaveLength(1);
  });

  // Shiki splits on the terminator too, so the highlighted path needs its own
  // trim — the unhighlighted one passing proves nothing about it.
  it("does not invent a line for a trailing newline when highlighting", async () => {
    const { container } = render(<CodeViewer text={"const x = 1;\n"} language="typescript" />);
    await waitFor(() => expect(tokensOf(container).length).toBeGreaterThan(1));
    expect(container.querySelectorAll("[aria-hidden]")).toHaveLength(1);
  });

  it("highlights a supported language with both theme colours per token", async () => {
    const { container } = render(<CodeViewer text="const x = 1;" language="typescript" />);
    // Shiki loads its grammar asynchronously; nothing is coloured until it lands.
    await waitFor(() => expect(tokensOf(container).length).toBeGreaterThan(1));

    const keyword = tokensOf(container).find((el) => el.textContent === "const");
    expect(keyword).toBeDefined();
    // Light colour inline, dark one as the custom property app.css swaps in.
    expect(keyword!.style.color).not.toBe("");
    expect(keyword!.style.getPropertyValue("--shiki-dark")).not.toBe("");
  });

  it("still renders the text when the language has no grammar", () => {
    render(<CodeViewer text="a,b,c" language="csv" />);
    expect(screen.getByText("a,b,c")).toBeInTheDocument();
  });

  it("skips highlighting past the size cap but keeps the text", () => {
    const big = `const x = 1;\n`.repeat(9000);
    const { container } = render(<CodeViewer text={big} language="typescript" />);
    expect(tokensOf(container)).toHaveLength(0);
    expect(container.querySelectorAll("[aria-hidden]")).toHaveLength(9000);
  });
});
