import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PivotDialog, type PivotDraft } from "./pivot-dialog.tsx";

afterEach(cleanup);

describe("the pivot table dialog", () => {
  it("starts with the first column as rows and the last as summed values", () => {
    const applied: PivotDraft[] = [];
    render(
      <PivotDialog
        fields={["Region", "Product", "Sales"]}
        onApply={(draft) => applied.push(draft)}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));
    expect(applied).toEqual([
      { rows: 0, columns: null, values: 2, summary: "SUM", place: "sheet", headers: true },
    ]);
  });
});
