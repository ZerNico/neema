import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatTextarea } from "./chat-textarea.tsx";
import {
  composerText,
  focusComposer,
  setComposerCaret,
  typeInComposer,
} from "./composer-test-utils.ts";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const collections = [
  { id: "col-1", label: "Contracts", description: "12 docs" },
  { id: "col-2", label: "Handbook", description: "3 docs" },
];

function Harness({ select, initial }: { select: (id: string) => void; initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <ChatTextarea
      value={value}
      onValueChange={setValue}
      onSubmit={() => {}}
      ariaLabel="Message"
      skills={{
        items: [{ id: "skill-1", label: "review", description: "Review carefully" }],
        onSelect: () => {},
      }}
      collections={{ items: collections, onSelect: select }}
    />
  );
}

const setup = (initial: string, caret: number) => {
  const select = vi.fn();
  render(<Harness select={select} initial={initial} />);
  const textbox = screen.getByRole("textbox");
  focusComposer(textbox);
  setComposerCaret(textbox, caret);
  return { textbox, select };
};

describe("collection # mentions", () => {
  it("adds the collection and removes the token, leaving the message text", async () => {
    const { textbox, select } = setup("Check #con please", 10);
    await screen.findByRole("listbox", { name: "Knowledge collections" });
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(select).toHaveBeenCalledWith("col-1");
    expect(composerText(textbox)).toBe("Check  please");
  });

  it("filters as the query narrows and lets the arrow keys pick another", async () => {
    const { textbox, select } = setup("Check # please", 7);
    const list = await screen.findByRole("listbox", { name: "Knowledge collections" });
    expect(within(list).getAllByRole("option")).toHaveLength(2);
    fireEvent.keyDown(textbox, { key: "ArrowDown" });
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(select).toHaveBeenCalledWith("col-2");
  });

  it("shares one popup with skills: the trigger at the caret decides the list", async () => {
    const { textbox } = setup("Ask /rev and #con", 8);
    expect(await screen.findByRole("listbox", { name: "Local skills" })).toBeVisible();
    setComposerCaret(textbox, 17);
    expect(await screen.findByRole("listbox", { name: "Knowledge collections" })).toBeVisible();
    expect(screen.queryByRole("listbox", { name: "Local skills" })).toBeNull();
  });

  it("stays out of the way mid-word", () => {
    setup("See issue#5", 11);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("offers the same collection again after it is added and removed", async () => {
    const select = vi.fn();
    render(<Harness select={select} initial="" />);
    const textbox = screen.getByRole("textbox");
    focusComposer(textbox);

    typeInComposer(textbox, "#");
    await screen.findByRole("listbox", { name: "Knowledge collections" });
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(select).toHaveBeenCalledWith("col-1");
    expect(composerText(textbox)).toBe("");

    // The chip is removed elsewhere, so the row is offered again, and typing
    // the trigger at the same caret must reopen the list, not stay suppressed
    // because an identical token was accepted there a moment ago.
    typeInComposer(textbox, "#");
    expect(await screen.findByRole("listbox", { name: "Knowledge collections" })).toBeVisible();
  });
});
