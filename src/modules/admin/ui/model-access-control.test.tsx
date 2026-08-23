import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelAccessControl } from "./model-access-control.tsx";
import { updateModelAccess } from "../server/functions.ts";

vi.mock("../server/functions.ts", () => ({
  listGroups: vi.fn(),
  listGroupMemberships: vi.fn(),
  listModelAccess: vi.fn(),
  updateModelAccess: vi.fn(),
}));

const updateMock = vi.mocked(updateModelAccess);

const group = (id: string, name: string) => ({
  id,
  name,
  memberCount: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const renderControl = (
  props: Partial<Parameters<typeof ModelAccessControl>[0]> = {},
  options: {
    groups?: ReturnType<typeof group>[];
    access?: Array<{ modelId: string; groupId: string }>;
  } = {},
) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["admin", "groups"], options.groups ?? [group("g1", "Engineering")]);
  client.setQueryData(["admin", "model-access"], options.access ?? []);
  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={null}>
        <ModelAccessControl modelId="m1" modelName="Tiny Chat" access="public" {...props} />
      </Suspense>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  updateMock.mockResolvedValue(undefined as never);
});

describe("ModelAccessControl", () => {
  it("states the audience on the trigger: public, counted groups, or none yet", async () => {
    renderControl();
    expect(
      await screen.findByRole("button", { name: /Access for Tiny Chat: Public/ }),
    ).toBeInTheDocument();
  });

  it("counts the allowed groups for a private model", async () => {
    renderControl(
      { access: "groups" },
      {
        groups: [group("g1", "Engineering"), group("g2", "Design")],
        access: [
          { modelId: "m1", groupId: "g1" },
          { modelId: "m1", groupId: "g2" },
          { modelId: "other", groupId: "g1" },
        ],
      },
    );
    expect(await screen.findByRole("button", { name: /2 groups/ })).toBeInTheDocument();
  });

  it("warns that an empty private model is admin-only", async () => {
    renderControl({ access: "groups" });
    fireEvent.click(await screen.findByRole("button", { name: /No groups yet/ }));
    expect(
      await screen.findByText("Visible to admins only until a group is added."),
    ).toBeInTheDocument();
  });

  it("saves a public model as-is without touching groups", async () => {
    renderControl();
    fireEvent.click(await screen.findByRole("button", { name: /Public/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith({
        data: { modelId: "m1", access: "public", groupIds: [] },
      }),
    );
  });

  it("restricts to picked groups through the chip combobox", async () => {
    renderControl();
    fireEvent.click(await screen.findByRole("button", { name: /Public/ }));

    // Flip to private, open the picker with the keyboard, choose the group.
    fireEvent.click(screen.getByRole("switch"));
    const input = screen.getByPlaceholderText("Add groups…");
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    (await screen.findByRole("option", { name: "Engineering" })).click();
    // Multi-select keeps the popup open (and the page behind it inert);
    // Escape returns to the dialog like a user would.
    fireEvent.keyDown(input, { key: "Escape" });

    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith({
        data: { modelId: "m1", access: "groups", groupIds: ["g1"] },
      }),
    );
  });
});
