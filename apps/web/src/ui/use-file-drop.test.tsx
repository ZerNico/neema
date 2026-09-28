import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useFileDrop } from "./use-file-drop.ts";

function Zone({ enabled, onDrop }: { enabled: boolean; onDrop: (files: FileList) => void }) {
  const { dragging, handlers } = useFileDrop({ enabled, onDrop });
  return (
    <div data-testid="zone" data-dragging={dragging} {...handlers}>
      <span data-testid="child">Child</span>
    </div>
  );
}

const files = [new File(["a"], "a.txt")];
const withFiles = { dataTransfer: { types: ["Files"], files } };

it("holds the highlight while the pointer crosses children, and drops once", () => {
  const onDrop = vi.fn();
  render(<Zone enabled onDrop={onDrop} />);
  const zone = screen.getByTestId("zone");
  fireEvent.dragEnter(zone, withFiles);
  fireEvent.dragEnter(screen.getByTestId("child"), withFiles);
  fireEvent.dragLeave(zone, withFiles);
  expect(zone).toHaveAttribute("data-dragging", "true");
  fireEvent.dragLeave(screen.getByTestId("child"), withFiles);
  expect(zone).toHaveAttribute("data-dragging", "false");

  fireEvent.dragEnter(zone, withFiles);
  fireEvent.dragEnter(screen.getByTestId("child"), withFiles);
  fireEvent.drop(screen.getByTestId("child"), withFiles);
  expect(zone).toHaveAttribute("data-dragging", "false");
  expect(onDrop).toHaveBeenCalledTimes(1);
  expect(onDrop).toHaveBeenCalledWith(files);
  // The drop reset the depth: one enter and leave settles it again.
  fireEvent.dragEnter(zone, withFiles);
  fireEvent.dragLeave(zone, withFiles);
  expect(zone).toHaveAttribute("data-dragging", "false");
});

it("lets text drags and every drag while disabled pass through", () => {
  const onDrop = vi.fn();
  const { rerender } = render(<Zone enabled onDrop={onDrop} />);
  const zone = screen.getByTestId("zone");
  const text = { dataTransfer: { types: ["text/plain"], files: [] } };
  expect(fireEvent.dragOver(zone, text)).toBe(true);
  fireEvent.dragEnter(zone, text);
  fireEvent.drop(zone, text);
  expect(zone).toHaveAttribute("data-dragging", "false");

  rerender(<Zone enabled={false} onDrop={onDrop} />);
  expect(fireEvent.dragOver(zone, withFiles)).toBe(true);
  fireEvent.dragEnter(zone, withFiles);
  fireEvent.drop(zone, withFiles);
  expect(zone).toHaveAttribute("data-dragging", "false");
  expect(onDrop).not.toHaveBeenCalled();
});
