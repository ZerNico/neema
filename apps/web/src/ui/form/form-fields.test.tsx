import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useAppForm } from "./app-form.ts";

function Form({ textarea = false, description = "Keep it brief." }) {
  const form = useAppForm({ defaultValues: { value: "" } });
  return (
    <form>
      <form.AppField
        name="value"
        validators={{ onChange: ({ value }) => (value.length < 3 ? "Too short." : undefined) }}
      >
        {(field) =>
          textarea ? (
            <field.TextareaField label="Notes" optional description={description} />
          ) : (
            <field.TextField label="Name" optional description={description} />
          )
        }
      </form.AppField>
      <button type="button">Leave field</button>
    </form>
  );
}

const descriptions = (control: HTMLElement) =>
  control
    .getAttribute("aria-describedby")
    ?.split(" ")
    .map((id) => document.getElementById(id));

describe("shared form fields", () => {
  it.each([false, true])(
    "associates rendered help and touched errors (textarea=%s)",
    async (textarea) => {
      const user = userEvent.setup();
      render(<Form textarea={textarea} />);
      const control = screen.getByRole("textbox", {
        name: textarea ? "Notes (optional)" : "Name (optional)",
      });
      const id = control.id;
      expect(control).toHaveAttribute("name", "value");
      expect(control).toHaveAccessibleDescription("Keep it brief.");
      expect(descriptions(control)).toEqual([screen.getByText("Keep it brief.")]);
      await user.type(control, "a");
      await user.click(screen.getByRole("button", { name: "Leave field" }));
      const error = await screen.findByRole("alert");
      expect(error).toHaveTextContent("Too short.");
      expect(control).toHaveAttribute("aria-invalid", "true");
      expect(control).toHaveAccessibleDescription("Keep it brief. Too short.");
      expect(descriptions(control)).toEqual([screen.getByText("Keep it brief."), error]);
      await user.type(control, "bc");
      await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
      expect(control).not.toHaveAttribute("aria-invalid");
      expect(control).toHaveAccessibleDescription("Keep it brief.");
      expect(control.id).toBe(id);
    },
  );

  it("omits references to absent descriptions and errors", () => {
    render(<Form description="" />);
    expect(screen.getByRole("textbox")).not.toHaveAttribute("aria-describedby");
  });

  it("keeps labels and descriptions local to each instance of the same form path", () => {
    render(
      <>
        <Form description="First name help." />
        <Form description="Second name help." />
      </>,
    );
    const controls = screen.getAllByRole("textbox", { name: "Name (optional)" });
    expect(controls[0]!.id).not.toBe(controls[1]!.id);
    expect(controls[0]).toHaveAccessibleDescription("First name help.");
    expect(controls[1]).toHaveAccessibleDescription("Second name help.");
    expect(descriptions(controls[0]!)).not.toEqual(descriptions(controls[1]!));
  });
});
