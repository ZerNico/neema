import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingButton } from "./pending-button.tsx";
import { SaveLabel, SaveStatus, useSaveStatus } from "./save-status.tsx";

function Editor() {
  const { justSaved, markSaved } = useSaveStatus();
  return (
    <>
      <PendingButton pending={false} onClick={markSaved}>
        <SaveLabel justSaved={justSaved}>Save changes</SaveLabel>
      </PendingButton>
      <SaveStatus justSaved={justSaved} />
    </>
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("saving in place", () => {
  it("says Saved in the button and to screen readers for a moment, then goes back", () => {
    render(<Editor />);
    const button = screen.getByRole("button", { name: "Save changes" });
    expect(screen.getByRole("status")).toHaveTextContent("");
    fireEvent.click(button);
    // The same button, renamed in place: nothing beside it moves.
    expect(screen.getByRole("button", { name: "Saved" })).toBe(button);
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByRole("button", { name: "Save changes" })).toBe(button);
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("keeps a pending button's label as its name under the spinner", () => {
    render(
      <PendingButton pending onClick={() => {}}>
        Run now
      </PendingButton>,
    );
    const button = screen.getByRole("button", { name: "Run now" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector('[data-slot="spinner"]')).toBeInTheDocument();
  });
});
