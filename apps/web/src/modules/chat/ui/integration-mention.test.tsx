import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
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

function Harness({ select, initial }: { select: (id: string) => void; initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <ChatTextarea
      value={value}
      onValueChange={setValue}
      onSubmit={() => {}}
      ariaLabel="Message"
      integrations={{
        items: [
          {
            id: "outline",
            label: "Outline",
            description: "ada@example.com",
            search: "outline Outline",
          },
        ],
        onSelect: select,
        insertText: (item) => `@${item.label} `,
      }}
    />
  );
}

const waitForAnimationFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

const setup = (initial: string, caret: number) => {
  const select = vi.fn();
  render(<Harness select={select} initial={initial} />);
  const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
  textbox.focus();
  textbox.setSelectionRange(caret, caret);
  fireEvent.select(textbox);
  return { textbox, select };
};

describe("integration @ mentions", () => {
  it("turns the service on and keeps it named in the message", async () => {
    const { textbox, select } = setup("Search @out for the plan", 11);
    await screen.findByRole("listbox", { name: "Integrations" });
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(select).toHaveBeenCalledWith("outline");
    expect(textbox.value).toBe("Search @Outline for the plan");
    // The caret sits past the space, so the list does not reopen on the
    // mention it just inserted and Enter sends instead of re-picking.
    await waitForAnimationFrame();
    expect(textbox.selectionStart).toBe("Search @Outline ".length);
    fireEvent.select(textbox);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("leaves an email address alone", () => {
    setup("Mail ada@out", 12);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
