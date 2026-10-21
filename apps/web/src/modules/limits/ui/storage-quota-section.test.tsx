import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { setGroupStorage } from "../server/functions.ts";
import { StorageQuotaSection } from "./storage-quota-section.tsx";

vi.mock("../client/queries.ts", () => ({
  storageQuotasQuery: { queryKey: ["test-quotas"], queryFn: () => null },
}));
vi.mock("../server/functions.ts", () => ({
  setEveryoneStorage: vi.fn(),
  setGroupStorage: vi.fn(),
}));

const GB = 1024 ** 3;

const renderSection = (
  groupId: string | null,
  quotas: { everyone: number | null; groups: { groupId: string; bytes: number | null }[] },
) => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["test-quotas"], quotas);
  render(
    <QueryClientProvider client={client}>
      <StorageQuotaSection groupId={groupId} />
    </QueryClientProvider>,
  );
};

describe("the storage quota editor", () => {
  it("shows everyone's quota, or that there is none", () => {
    renderSection(null, { everyone: 5 * GB, groups: [] });
    expect(screen.getByText("5.0 GB")).toBeVisible();
  });

  it("shows a group what everyone has beside its own", () => {
    renderSection("power", { everyone: 5 * GB, groups: [{ groupId: "power", bytes: null }] });
    expect(screen.getByText("No quota")).toBeVisible();
    expect(screen.getByText("Everyone else: 5.0 GB")).toBeVisible();
    expect(screen.getByRole("button", { name: "Use everyone’s" })).toBeVisible();
  });

  it("sets a group's own quota in GB", async () => {
    vi.mocked(setGroupStorage).mockResolvedValue(undefined as never);
    renderSection("interns", { everyone: 5 * GB, groups: [] });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Change for this group" }));
    const size = screen.getByLabelText("Size in GB");
    await user.clear(size);
    await user.type(size, "1.5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(setGroupStorage).toHaveBeenCalledWith({
        data: { groupId: "interns", bytes: Math.round(1.5 * GB) },
      }),
    );
  });
});
