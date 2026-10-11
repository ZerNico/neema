import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FilterRule } from "@chat/sheet/model/filter";
import type { SortKey } from "@chat/sheet-react/commands";
import { FilterMenu } from "./filter-menu.tsx";
import { SortDialog } from "./sort-dialog.tsx";

afterEach(cleanup);

describe("a filter button's menu", () => {
  it("keeps the values left ticked, and nothing changes before OK", async () => {
    const applied: Array<FilterRule | null> = [];
    const anchor = document.createElement("button");
    document.body.append(anchor);
    render(
      <FilterMenu
        anchor={anchor}
        name="Region"
        choices={[
          { value: "East", count: 1 },
          { value: "North", count: 2 },
          { value: "", count: 1 },
        ]}
        rule={undefined}
        onApply={(rule) => applied.push(rule)}
        onSort={() => {}}
        onClose={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("checkbox", { name: /East/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /\(Blanks\)/ }));
    expect(applied).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(applied).toEqual([{ values: ["North"] }]);
    anchor.remove();
  });
});

describe("the Sort dialog", () => {
  it("sorts by levels in turn, its first row kept as headers", async () => {
    const sorted: Array<[SortKey[], boolean]> = [];
    render(
      <SortDialog
        columns={[
          { id: "c1", letter: "A", header: "Region" },
          { id: "c2", letter: "B", header: "Total" },
        ]}
        headersByDefault
        onSort={(keys, headers) => sorted.push([keys, headers])}
        onClose={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Add level" }));
    fireEvent.click(screen.getByRole("button", { name: "Sort" }));
    expect(sorted).toEqual([
      [
        [
          { column: "c1", descending: false },
          { column: "c1", descending: false },
        ],
        true,
      ],
    ]);
  });
});
