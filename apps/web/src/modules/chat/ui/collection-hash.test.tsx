import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatTextarea } from "./chat-textarea.tsx";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
vi.mock("textarea-caret", () => ({ default: () => ({ top: 20, left: 80, height: 24 }) }));

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
  const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
  textbox.focus();
  textbox.setSelectionRange(caret, caret);
  fireEvent.select(textbox);
  return { textbox, select };
};

describe("collection # mentions", () => {
  it("adds the collection and removes the token, leaving the message text", async () => {
    const { textbox, select } = setup("Check #con please", 10);
    await screen.findByRole("listbox", { name: "Knowledge collections" });
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(select).toHaveBeenCalledWith("col-1");
    expect(textbox.value).toBe("Check  please");
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
    textbox.setSelectionRange(17, 17);
    fireEvent.select(textbox);
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
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
    textbox.focus();

    const type = (next: string) => {
      fireEvent.change(textbox, { target: { value: next } });
      textbox.setSelectionRange(next.length, next.length);
      fireEvent.select(textbox);
    };

    type("#");
    await screen.findByRole("listbox", { name: "Knowledge collections" });
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(select).toHaveBeenCalledWith("col-1");
    // Accepting restores the caret on the next frame; let that land, as it
    // does long before a real keystroke.
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));

    // The chip is removed elsewhere, so the row is offered again, and typing
    // the trigger at the same caret must reopen the list, not stay suppressed
    // because an identical token was accepted there a moment ago.
    type("#");
    expect(await screen.findByRole("listbox", { name: "Knowledge collections" })).toBeVisible();
  });
});
