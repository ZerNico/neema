import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueueStrip, type QueuedMessage } from "./queue-strip.tsx";

const entries: QueuedMessage[] = [
  "First queued request",
  "Second queued request",
  "Third queued request",
  "Fourth queued request",
].map((content, index) => ({
  id: `entry-${index + 1}`,
  content,
  lastError: null,
  attachments: [],
}));

const strip = (overrides: Partial<Parameters<typeof QueueStrip>[0]> = {}) => {
  const props = {
    entries,
    generating: true,
    steeringIds: new Set<string>(),
    editingId: null,
    editBlocked: null,
    paused: null,
    onSteer: vi.fn(),
    onRemove: vi.fn(),
    onEdit: vi.fn(),
    onSendNow: vi.fn(),
    sendNowBlocked: null,
    onDispatch: vi.fn(),
    ...overrides,
  };
  render(<QueueStrip {...props} />);
  return props;
};

describe("QueueStrip", () => {
  it("keeps steering, editing and removal on the queued row", async () => {
    const props = strip();
    expect(screen.getByText("4 messages queued")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Steer: Second queued request" }));
    expect(props.onSteer).toHaveBeenCalledExactlyOnceWith("entry-2");
    fireEvent.click(screen.getByRole("button", { name: "More actions: Third queued request" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    expect(props.onEdit).toHaveBeenCalledExactlyOnceWith("entry-3");
    fireEvent.click(screen.getByRole("button", { name: "Remove: First queued request" }));
    expect(props.onRemove).toHaveBeenCalledExactlyOnceWith("entry-1");
    expect(screen.queryByText("Fourth queued request")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "1 more" }));
    expect(screen.getByText("Fourth queued request")).toBeInTheDocument();
  });

  it("spends no line on a heading while the answer runs", () => {
    strip({ entries: entries.slice(0, 1) });
    // The count is still announced, just not drawn.
    expect(screen.getByRole("status")).toHaveTextContent("1 message queued");
    expect(screen.getByRole("status")).toHaveClass("sr-only");
    expect(screen.getByRole("list", { name: "1 message queued" })).toBeInTheDocument();
    // A lone entry has no order to show.
    expect(screen.queryByText("1")).toBeNull();
  });

  it("offers manual dispatch only when starting by hand could work", () => {
    const props = strip({
      entries: entries.slice(0, 1),
      generating: false,
      paused: { reason: "Queue paused", canDispatch: true },
    });
    expect(screen.getByText("Queue paused")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Steer:/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send next" }));
    expect(props.onDispatch).toHaveBeenCalledOnce();
  });

  it("says a Work queue needs the desktop app instead of offering a button that cannot work", () => {
    strip({
      entries: entries.slice(0, 1),
      generating: false,
      paused: { reason: "Open Chat Desktop to continue this work", canDispatch: false },
    });
    expect(screen.getByText("Open Chat Desktop to continue this work")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send next" })).toBeNull();
  });

  it("names a file-only entry by its files and links them through the authenticated route", () => {
    strip({
      entries: [
        {
          id: "files",
          content: "",
          lastError: null,
          attachments: [
            { id: "a-1", fileName: "notes.txt", size: 5, mediaType: "text/plain", kind: "text" },
          ],
        },
      ],
    });
    expect(screen.getByRole("button", { name: "Remove: notes.txt" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /notes\.txt/ })).toHaveAttribute(
      "href",
      "/api/files/a-1",
    );
  });

  it("locks the row being edited and explains why other rows cannot open", async () => {
    strip({ editingId: "entry-1", editBlocked: "Finish the edit that is open first" });
    expect(screen.getByText("Editing")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Steer: First queued request" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove: First queued request" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions: Second queued request" }));
    expect(await screen.findByRole("menuitem", { name: "Edit" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByText("Finish the edit that is open first")).toBeInTheDocument();
  });

  it("refuses Send now where nothing could start, and says why", async () => {
    const props = strip({ sendNowBlocked: "Open Chat Desktop to send queued work" });
    fireEvent.click(screen.getByRole("button", { name: "More actions: First queued request" }));
    expect(await screen.findByRole("menuitem", { name: "Stop and send now" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByText("Open Chat Desktop to send queued work")).toBeInTheDocument();
    expect(props.onSendNow).not.toHaveBeenCalled();
  });

  it("says a steered row goes in at the next step instead of offering Steer again", () => {
    strip({ entries: entries.slice(0, 1), steeringIds: new Set(["entry-1"]) });
    expect(screen.getByText("Sends at the next step")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Steer:/ })).toBeNull();
  });

  it("stops the answer to send a row now, or just sends it when nothing runs", async () => {
    const running = strip({ entries: entries.slice(0, 1) });
    fireEvent.click(screen.getByRole("button", { name: "More actions: First queued request" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Stop and send now" }));
    expect(running.onSendNow).toHaveBeenCalledExactlyOnceWith("entry-1");
    cleanup();

    const paused = strip({
      entries: entries.slice(0, 1),
      generating: false,
      paused: { reason: "Queue paused", canDispatch: true },
    });
    fireEvent.click(screen.getByRole("button", { name: "More actions: First queued request" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Send now" }));
    expect(paused.onSendNow).toHaveBeenCalledExactlyOnceWith("entry-1");
  });
});
