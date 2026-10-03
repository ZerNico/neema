import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  SortableHandle,
  SortableItem,
  SortableList,
  SortableMoveButtons,
} from "./sortable-list.tsx";
import { moveId } from "./move-id.ts";

describe("moveId", () => {
  it("moves one entry either way and leaves the input alone", () => {
    const ids = ["a", "b", "c", "d"];
    expect(moveId(ids, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveId(ids, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(ids).toEqual(["a", "b", "c", "d"]);
  });
});

describe("SortableList", () => {
  it("gives each row a named handle and buttons that report the same move as a drag", async () => {
    const onMove = vi.fn();
    const names = ["Alpha", "Beta"];
    render(
      <SortableList onMove={onMove}>
        {names.map((name, index) => (
          <SortableItem key={name} id={name} index={index}>
            <SortableHandle label={name} />
            <SortableMoveButtons label={name} index={index} count={names.length} onMove={onMove} />
          </SortableItem>
        ))}
      </SortableList>,
    );
    const user = userEvent.setup();

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Drag Beta" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move Alpha up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Beta down" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Move Beta up" }));
    expect(onMove).toHaveBeenCalledWith(1, 0);
  });
});
