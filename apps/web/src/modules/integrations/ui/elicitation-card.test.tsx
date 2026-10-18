import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PendingIntegrationCall } from "../schema.ts";
import { answerIntegrationElicitation } from "../server/functions.ts";
import { ElicitationCard } from "./elicitation-card.tsx";

vi.mock("../server/functions.ts", () => ({
  answerIntegrationElicitation: vi.fn(async () => ({ ok: true })),
  listPendingIntegrationCalls: vi.fn(async () => []),
  listIntegrationDirectory: vi.fn(async () => []),
}));

const call = (prompt: NonNullable<PendingIntegrationCall["prompt"]>): PendingIntegrationCall => ({
  kind: "elicitation",
  callId: "row-1",
  conversationId: "c",
  messageId: "m",
  integrationId: "mcp",
  tool: "release",
  label: "Create issue",
  access: "write",
  summary: null,
  targets: [],
  prompt,
  promptId: "q-1",
  expiresAt: Date.now() + 60_000,
});

const mount = (pending: PendingIntegrationCall) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ElicitationCard call={pending} name="Docs" />
    </QueryClientProvider>,
  );

describe("a server asking mid-call", () => {
  it("sends the form only once it is complete, and warns against secrets", async () => {
    const user = userEvent.setup();
    mount(
      call({
        mode: "form",
        message: "Name this release.",
        fields: [
          { key: "name", label: "Release name", description: null, kind: "text", required: true },
          { key: "count", label: "Builds", description: null, kind: "integer", required: false },
        ],
      }),
    );
    expect(screen.getByText("Docs is asking")).toBeInTheDocument();
    expect(screen.getByText(/Don’t enter passwords or keys here/)).toBeInTheDocument();
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText("Release name"), "v2");
    await user.type(screen.getByLabelText(/Builds/), "3");
    await user.click(send);
    await waitFor(() =>
      expect(answerIntegrationElicitation).toHaveBeenCalledWith({
        data: {
          callId: "row-1",
          promptId: "q-1",
          action: "accept",
          values: { name: "v2", count: 3 },
        },
      }),
    );
  });

  it("leaves out an optional list nobody picked from, rather than answering with none", async () => {
    const user = userEvent.setup();
    vi.mocked(answerIntegrationElicitation).mockClear();
    mount(
      call({
        mode: "form",
        message: "Name it.",
        fields: [
          { key: "name", label: "Name", description: null, kind: "text", required: true },
          {
            key: "labels",
            label: "Labels",
            description: null,
            kind: "choices",
            required: false,
            min: 1,
            options: [{ value: "bug", label: "Bug" }],
          },
        ],
      }),
    );
    await user.type(screen.getByLabelText("Name"), "v3");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(answerIntegrationElicitation).toHaveBeenCalledWith({
        data: { callId: "row-1", promptId: "q-1", action: "accept", values: { name: "v3" } },
      }),
    );
  });

  it("shows where a link goes and lets the person say they are done only after opening it", async () => {
    const user = userEvent.setup();
    mount(
      call({
        mode: "url",
        message: "Approve the payment.",
        url: "https://pay.example.com/approve?x=1",
      }),
    );
    expect(screen.getByText("pay.example.com")).toBeInTheDocument();
    const open = screen.getByRole("link", { name: /Open pay\.example\.com/ });
    expect(open).toHaveAttribute("target", "_blank");
    expect(open).toHaveAttribute("rel", "noopener noreferrer");
    const done = screen.getByRole("button", { name: "I’m done" });
    expect(done).toBeDisabled();
    open.addEventListener("click", (event) => event.preventDefault());
    await user.click(open);
    expect(done).toBeEnabled();
    await user.click(done);
    await waitFor(() =>
      expect(answerIntegrationElicitation).toHaveBeenCalledWith({
        data: { callId: "row-1", promptId: "q-1", action: "accept" },
      }),
    );
  });
});
