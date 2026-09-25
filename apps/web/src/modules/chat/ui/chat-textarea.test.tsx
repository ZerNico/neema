import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChatTextarea } from "./chat-textarea.tsx";
import {
  composerEditor,
  composerTagCount,
  composerText,
  setComposerCaret,
  typeInComposer,
} from "./composer-test-utils.ts";

const noop = () => undefined;

/** Owns the value, as the composer does, so an edit lands in the next render. */
function Controlled({
  initial,
  onChange = noop,
  onSubmit = noop,
  onCancel,
  onSelectIntegration,
}: {
  initial: string;
  onChange?: (value: string) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  onSelectIntegration?: (id: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ChatTextarea
        value={value}
        onValueChange={(next) => {
          setValue(next);
          onChange(next);
        }}
        onSubmit={onSubmit}
        onCancel={onCancel}
        ariaLabel="Message"
        {...(onSelectIntegration
          ? {
              integrations: {
                items: [{ id: "outline", label: "Outline" }],
                onSelect: onSelectIntegration,
              },
            }
          : {})}
      />
      <button type="button" onClick={() => setValue("")}>
        Clear from outside
      </button>
    </>
  );
}

const field = () => screen.getByRole("textbox", { name: "Message" });

describe("ChatTextarea", () => {
  it("submits on Enter", () => {
    const onSubmit = vi.fn();
    render(<Controlled initial="draft" onSubmit={onSubmit} />);
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("starts a new line on Shift+Enter instead of submitting", () => {
    const onSubmit = vi.fn();
    render(<Controlled initial="draft" onSubmit={onSubmit} />);
    act(() => composerEditor(field()).commands.focus("end"));
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    typeInComposer(field(), "more");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(composerText(field())).toBe("draft\nmore");
  });

  it("cancels on Escape", () => {
    const onCancel = vi.fn();
    render(<Controlled initial="draft" onCancel={onCancel} />);
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("does not submit or cancel during IME composition", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<Controlled initial="draft" onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(field(), { key: "Escape", isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("hands out lines, blank lines and mentions as the text they came in as", () => {
    const text = "first line\n\n@Outline and @outline, done";
    render(<Controlled initial={text} />);
    expect(composerText(field())).toBe(text);
    expect(composerTagCount(field())).toBe(2);
  });

  it("removes a whole tag with one Backspace or Delete, and undo brings it back", () => {
    const onChange = vi.fn();
    render(<Controlled initial="ask @Outline now" onChange={onChange} />);

    setComposerCaret(field(), "ask ".length + 1);
    fireEvent.keyDown(field(), { key: "Backspace" });
    expect(onChange).toHaveBeenLastCalledWith("ask  now");

    act(() => composerEditor(field()).commands.undo());
    expect(onChange).toHaveBeenLastCalledWith("ask @Outline now");

    setComposerCaret(field(), "ask ".length);
    fireEvent.keyDown(field(), { key: "Delete" });
    expect(onChange).toHaveBeenLastCalledWith("ask  now");
  });

  it("turns a typed-out @Outline into a tag and switches the integration on", async () => {
    const onSelectIntegration = vi.fn();
    render(<Controlled initial="" onSelectIntegration={onSelectIntegration} />);
    act(() => composerEditor(field()).commands.focus());
    typeInComposer(field(), "check @Outline for it");
    expect(composerText(field())).toBe("check @Outline for it");
    expect(composerTagCount(field())).toBe(1);
    await act(async () => {});
    expect(onSelectIntegration).toHaveBeenCalledWith("outline");
  });

  it("takes an outside value without echoing it back as an edit", () => {
    const onChange = vi.fn();
    render(<Controlled initial="draft" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear from outside" }));
    expect(composerText(field())).toBe("");
    expect(onChange).not.toHaveBeenCalled();
  });
});
