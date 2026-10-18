import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { unexpectedFailureBody } from "~/server-error.ts";
import { NameDialog } from "./name-dialog.tsx";

const renderDialog = (props: Partial<Parameters<typeof NameDialog>[0]> = {}) => {
  const onSubmit = vi.fn(async (_name: string) => {});
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NameDialog
        open
        onOpenChange={onOpenChange}
        title="Rename thing"
        initial="Plan"
        maxLength={10}
        submitLabel="Rename"
        failure="Could not rename the thing."
        onSubmit={onSubmit}
        {...props}
      />
    </QueryClientProvider>,
  );
  const field = screen.getByLabelText("Name");
  const submit = () => fireEvent.submit(field.closest("form")!);
  const type = (value: string) => fireEvent.change(field, { target: { value } });
  return { onSubmit, onOpenChange, field, submit, type };
};

describe("NameDialog", () => {
  it("saves the trimmed name and closes", async () => {
    const { onSubmit, onOpenChange, submit, type } = renderDialog();
    type("  Launch  ");
    submit();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onSubmit).toHaveBeenCalledWith("Launch", expect.anything());
  });

  it("closes without a request when nothing changed", () => {
    const unchanged = renderDialog();
    unchanged.type(" Plan ");
    unchanged.submit();
    expect(unchanged.onSubmit).not.toHaveBeenCalled();
    expect(unchanged.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("saves an unchanged name when a field beside it changed", async () => {
    const { onSubmit, submit } = renderDialog({ changed: true });
    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Plan", expect.anything()));
  });

  it("refuses a name past its bound before asking the server", () => {
    const { onSubmit, submit, type } = renderDialog();
    type("A much longer name");
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Keep it to 10 characters.")).toBeVisible();
  });

  it("shows the server's reason, or its own words when there is none", async () => {
    const reasoned = renderDialog({
      onSubmit: async () => {
        throw new Error("A thing with this name already exists.");
      },
    });
    reasoned.type("Taken");
    reasoned.submit();
    expect(await screen.findByText("A thing with this name already exists.")).toBeVisible();
  });

  it("falls back to its failure line for an unexpected error", async () => {
    const failed = renderDialog({
      onSubmit: async () => {
        throw new Error(unexpectedFailureBody("ABC234"));
      },
    });
    failed.type("Other");
    failed.submit();
    expect(await screen.findByText("Could not rename the thing.")).toBeVisible();
    expect(failed.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("starts from the current name each time it opens", () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <QueryClientProvider client={new QueryClient()}>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <NameDialog
            open={open}
            onOpenChange={setOpen}
            title="Rename thing"
            initial="Plan"
            maxLength={10}
            submitLabel="Rename"
            failure="Could not rename the thing."
            onSubmit={async () => {}}
          />
        </QueryClientProvider>
      );
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Plan");
  });
});
