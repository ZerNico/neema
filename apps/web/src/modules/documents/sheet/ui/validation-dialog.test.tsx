import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ValidationDialog, type ValidationDraft } from "./validation-dialog.tsx";

afterEach(cleanup);

describe("the Data Validation dialog", () => {
  it("edits a cell's rule, a written list kept in order without repeats", async () => {
    const applied: Array<ValidationDraft | null> = [];
    render(
      <ValidationDialog
        current={{
          id: "v1",
          box: { r1: "a", r2: "a", c1: "b", c2: "b" },
          rule: { kind: "list", values: ["Open"] },
          onError: "stop",
          allowBlank: true,
        }}
        currentRange={null}
        readDate={() => null}
        onApply={(draft) => applied.push(draft)}
        onClose={() => {}}
      />,
    );
    const source = await screen.findByLabelText<HTMLInputElement>("Source");
    expect(source.value).toBe("Open");
    fireEvent.change(source, { target: { value: "Open, Done, Open, Blocked" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(applied).toEqual([
      {
        allowBlank: true,
        onError: "stop",
        rule: { kind: "list", values: ["Open", "Done", "Blocked"] },
      },
    ]);
  });
});
