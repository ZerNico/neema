import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatTextarea } from "~/modules/chat/ui/chat-textarea.tsx";
import type { SkillSummary } from "../schema.ts";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
vi.mock("textarea-caret", () => ({ default: () => ({ top: 20, left: 80, height: 24 }) }));
const item: SkillSummary = {
  id: "skill-1",
  name: "review",
  description: "Review carefully",
  manualOnly: false,
  audience: "private",
  canEdit: true,
  ownerName: null,
  revision: 1,
  updatedAt: "2026-09-08",
};
function Harness({
  submit,
  select,
  cancel,
}: {
  submit: () => void;
  select: (id: string) => void;
  cancel: () => void;
}) {
  const [value, setValue] = useState("Before /rev after");
  return (
    <ChatTextarea
      value={value}
      onValueChange={setValue}
      onSubmit={submit}
      onCancel={cancel}
      ariaLabel="Message"
      skills={{
        items: [{ id: item.id, label: item.name, description: item.description }],
        onSelect: select,
      }}
    />
  );
}
function setup() {
  const submit = vi.fn(),
    select = vi.fn(),
    cancel = vi.fn();
  render(<Harness submit={submit} select={select} cancel={cancel} />);
  const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
  textbox.focus();
  textbox.setSelectionRange(11, 11);
  fireEvent.select(textbox);
  return { textbox, submit, select, cancel };
}
describe("native textarea skill suggestions", () => {
  it("keeps a textbox and selects the skill without sending", async () => {
    const { textbox, submit, select } = setup();
    await screen.findByRole("listbox", { name: "Local skills" });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(textbox).toHaveFocus();
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(submit).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledWith("skill-1");
    expect(textbox.value).toBe("Before  after");
  });
  it("dismisses suggestions before cancelling an edit", async () => {
    const { textbox, cancel } = setup();
    await screen.findByRole("listbox");
    fireEvent.keyDown(textbox, { key: "Escape" });
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.keyDown(textbox, { key: "Escape" });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("does not accept during IME composition or Shift+Enter", async () => {
    const { textbox, select, submit } = setup();
    await screen.findByRole("listbox");
    fireEvent.keyDown(textbox, { key: "Enter", isComposing: true });
    fireEvent.keyDown(textbox, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(textbox, { key: "Enter", shiftKey: true });
    expect(select).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});
