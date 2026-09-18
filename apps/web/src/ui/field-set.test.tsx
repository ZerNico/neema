import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { FieldSet } from "./field-set.tsx";

describe("FieldSet", () => {
  it("keeps default spacing and opts into compact spacing", () => {
    const { rerender } = render(<FieldSet aria-label="Settings" />);
    const fieldset = screen.getByRole("group", { name: "Settings" });
    expect(fieldset).toHaveClass("gap-6");
    expect(fieldset).not.toHaveClass("gap-4");

    rerender(<FieldSet aria-label="Settings" compact />);
    expect(fieldset).toHaveClass("gap-4");
    expect(fieldset).not.toHaveClass("gap-6");
    expect(fieldset).not.toHaveAttribute("compact");
  });

  it("forwards refs, layout classes and disabled state", () => {
    const ref = createRef<HTMLFieldSetElement>();
    render(
      <FieldSet ref={ref} compact disabled className="min-w-0" aria-label="Settings">
        <input aria-label="Name" />
      </FieldSet>,
    );
    const fieldset = screen.getByRole("group", { name: "Settings" });
    expect(ref.current).toBe(fieldset);
    expect(fieldset).toHaveClass("gap-4", "min-w-0");
    expect(fieldset).toHaveAttribute("data-slot", "field-set");
    expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
  });
});
