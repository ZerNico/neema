import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { announceTicketRedeemed } from "~/modules/auth/ticket-events.ts";
import { TicketCode } from "./ticket-code.tsx";

const TICKET = "K7MX4QPD9RTA2HCVB3N5";
const EXPIRES = new Date(Date.now() + 180_000).toISOString();

describe("TicketCode", () => {
  it("reacts only to its own ticket and resets when a new one arrives", async () => {
    const user = userEvent.setup();
    const onRenew = vi.fn();
    const view = render(
      <TicketCode ticket={TICKET} ticketId="t1" expiresAt={EXPIRES} onRenew={onRenew} renewing={false} />,
    );

    act(() => announceTicketRedeemed("t2"));
    expect(screen.getByTestId("ticket-code")).toBeInTheDocument();

    act(() => announceTicketRedeemed("t1"));
    expect(await screen.findByRole("status")).toHaveTextContent("Signed in on the new device.");
    await user.click(screen.getByRole("button", { name: "Generate another code" }));
    expect(onRenew).toHaveBeenCalledTimes(1);

    view.rerender(
      <TicketCode ticket="ABCDEFGHJKMNPQRSTVWX" ticketId="t2" expiresAt={EXPIRES} onRenew={onRenew} renewing={false} />,
    );
    expect(screen.getByTestId("ticket-code")).toHaveTextContent("ABCDE-FGHJK-MNPQR-STVWX");
  });

  it("stops listening once unmounted", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(
      <TicketCode ticket={TICKET} ticketId="t1" expiresAt={EXPIRES} onRenew={() => {}} renewing={false} />,
    );
    unmount();
    expect(remove).toHaveBeenCalledWith("chat:desktop-session-created", expect.any(Function));
  });
});
