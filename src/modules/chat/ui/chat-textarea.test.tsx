import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatTextarea } from "./chat-textarea.tsx";

function renderTextarea({
  onSubmit = vi.fn(),
  onCancel = vi.fn(),
}: {
  onSubmit?: () => void;
  onCancel?: () => void;
} = {}) {
  render(
    <ChatTextarea
      value="draft"
      onValueChange={() => undefined}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />,
  );
  return { textarea: screen.getByRole("textbox"), onSubmit, onCancel };
}

describe("ChatTextarea", () => {
  it("submits on Enter", () => {
    const { textarea, onSubmit } = renderTextarea();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("leaves Shift+Enter for a newline", () => {
    const { textarea, onSubmit } = renderTextarea();
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("cancels on Escape", () => {
    const { textarea, onCancel } = renderTextarea();
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("does not submit or cancel during IME composition", () => {
    const { textarea, onSubmit, onCancel } = renderTextarea();
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    fireEvent.keyDown(textarea, { key: "Escape", isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
