import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { IntegrationGrant } from "~/modules/integrations/grant.ts";
import { ScheduleAllowanceFields } from "./schedule-allowance-fields.tsx";

/** Holds the grant like the form does, and shows what it would save. */
function Host({ initial }: { initial: IntegrationGrant }) {
  const [grant, setGrant] = useState(initial);
  return (
    <>
      <ScheduleAllowanceFields grant={grant} onChange={setGrant} />
      <output data-testid="grant">{JSON.stringify(grant)}</output>
    </>
  );
}
const saved = () => JSON.parse(screen.getByTestId("grant").textContent!) as IntegrationGrant;
const write: IntegrationGrant = { integrationId: "outlook", access: "write" };

describe("schedule allowances", () => {
  it("offers nothing to read-only access or an integration without allowances", () => {
    const { unmount } = render(<Host initial={{ ...write, access: "read" }} />);
    expect(screen.queryByRole("switch")).toBeNull();
    unmount();
    render(<Host initial={{ integrationId: "outline", access: "write" }} />);
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("collects exact addresses per allowance and refuses anything else", () => {
    render(<Host initial={write} />);
    fireEvent.click(screen.getByRole("switch", { name: "Send mail" }));
    expect(saved().allowances).toEqual({ send: { targets: [] } });
    expect(screen.getByText("Add at least one address.")).toBeInTheDocument();

    const input = screen.getByRole("combobox", { name: "Send mail: addresses" });
    fireEvent.change(input, { target: { value: "Ana@Example.com, bo@example.com " } });
    expect(saved().allowances).toEqual({
      send: { targets: ["ana@example.com", "bo@example.com"] },
    });

    fireEvent.change(input, { target: { value: "Eve <eve@example.com>," } });
    expect(screen.getByText(/is not a plain email address/)).toBeInTheDocument();
    expect(saved().allowances?.send?.targets).toHaveLength(2);

    // Inviting is its own list.
    expect(screen.getByRole("switch", { name: "Invite people" })).not.toBeChecked();

    fireEvent.click(screen.getByRole("switch", { name: "Send mail" }));
    expect(saved()).toEqual(write);
  });
});
