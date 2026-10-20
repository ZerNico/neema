import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import type { LimitRule } from "../rules.ts";
import { saveUsageLimit } from "../server/functions.ts";
import { LimitsSection } from "./limits-editor.tsx";

vi.mock("../client/queries.ts", () => ({
  usageLimitRulesQuery: { queryKey: ["test-rules"], queryFn: () => null },
}));
vi.mock("~/modules/admin/client/queries.ts", () => ({
  modelsQuery: { queryKey: ["test-models"], queryFn: () => [] },
}));
vi.mock("../server/functions.ts", () => ({
  deleteUsageLimit: vi.fn(),
  saveUsageLimit: vi.fn(),
  setLimitTimeZone: vi.fn(),
}));

const rule = (overrides: Partial<LimitRule> & Pick<LimitRule, "id">): LimitRule => ({
  groupId: null,
  metric: "cost",
  period: "month",
  amount: 10,
  modelIds: null,
  ...overrides,
});

const renderSection = (groupId: string | null, rules: LimitRule[]) => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["test-rules"], { rules, timeZone: "Europe/Berlin" });
  client.setQueryData(["test-models"], [{ id: "opus", displayName: "Claude Opus", type: "chat" }]);
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <LimitsSection groupId={groupId} />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

describe("the limits editor", () => {
  it("lists everyone's limits with the time zone their periods begin in", () => {
    renderSection(null, [
      rule({ id: "month" }),
      rule({ id: "opus", metric: "answers", period: "day", amount: 20, modelIds: ["opus"] }),
    ]);
    expect(screen.getByText("Up to $10.00 per month")).toBeVisible();
    expect(screen.getByText("Up to 20 answers per day with Claude Opus")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Time zone, Europe/Berlin" })).toBeVisible();
  });

  it("shows a group what it inherits, what it changed, and its own extra limits", () => {
    renderSection("power", [
      rule({ id: "month" }),
      rule({ id: "day", period: "day", amount: 2 }),
      rule({ id: "power-month", groupId: "power", amount: 50 }),
      rule({ id: "power-day", groupId: "power", period: "day", amount: null }),
      rule({ id: "power-week", groupId: "power", period: "week", amount: 20 }),
      rule({ id: "other", groupId: "other", amount: 99 }),
    ]);
    const changed = screen.getByText("Up to $50.00 per month").closest("div")!.parentElement!;
    expect(within(changed).getByText("Everyone else: Up to $10.00 per month")).toBeVisible();
    expect(within(changed).getByRole("button", { name: "Use everyone’s" })).toBeVisible();
    expect(screen.getByText("No limit on cost per day")).toBeVisible();
    expect(screen.getByText("Up to $20.00 per week")).toBeVisible();
    // Another group's rule is no business of this one.
    expect(screen.queryByText("Up to $99.00 per month")).not.toBeInTheDocument();
  });

  it("offers to change an inherited limit the group has left alone", () => {
    renderSection("interns", [rule({ id: "month" })]);
    expect(screen.getByText("Everyone’s limit")).toBeVisible();
    expect(screen.getByRole("button", { name: "Change for this group" })).toBeVisible();
  });

  it("changes an inherited limit for the group alone, keeping what it counts", async () => {
    vi.mocked(saveUsageLimit).mockResolvedValue({} as never);
    renderSection("interns", [
      rule({ id: "opus", metric: "answers", period: "day", amount: 20, modelIds: ["opus"] }),
    ]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Change for this group" }));
    // What it counts is everyone's; only the amount is the group's to set.
    expect(screen.queryByText("What it counts")).not.toBeInTheDocument();
    const amount = screen.getByLabelText("Number of answers");
    await user.clear(amount);
    await user.type(amount, "5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(saveUsageLimit).toHaveBeenCalledWith({
        data: {
          id: null,
          groupId: "interns",
          metric: "answers",
          period: "day",
          amount: 5,
          modelIds: ["opus"],
        },
      }),
    );
  });

  it("lifts an inherited limit for the group with No limit", async () => {
    vi.mocked(saveUsageLimit)
      .mockClear()
      .mockResolvedValue({} as never);
    renderSection("devs", [rule({ id: "month" })]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Change for this group" }));
    await user.click(screen.getByRole("checkbox", { name: "No limit for this group" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(saveUsageLimit).toHaveBeenCalledWith({
        data: expect.objectContaining({ id: null, groupId: "devs", amount: null, modelIds: null }),
      }),
    );
  });
});
