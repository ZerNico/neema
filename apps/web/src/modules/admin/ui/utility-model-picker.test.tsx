import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UtilityModelPicker } from "./default-model-order.tsx";
import { getUtilityModel, updateUtilityModel } from "../server/functions.ts";

vi.mock("../server/functions.ts", () => ({
  getUtilityModel: vi.fn(),
  updateDefaultModelOrder: vi.fn(),
  updateUtilityModel: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const model = (id: string, displayName: string, type: "chat" | "embedding" = "chat") => ({
  id,
  displayName,
  defaultPriority: null,
  providerId: "p",
  type,
  enabled: true,
});

const setup = (current: string | null) => {
  let stored = current;
  vi.mocked(getUtilityModel).mockImplementation(async () => ({ modelId: stored }));
  vi.mocked(updateUtilityModel).mockImplementation(async ({ data }) => {
    stored = data.modelId;
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <UtilityModelPicker
        models={[model("a", "Alpha"), model("b", "Beta"), model("e", "Embed", "embedding")]}
        providers={[{ id: "p", name: "Provider", enabled: true }]}
      />
    </QueryClientProvider>,
  );
};

beforeEach(() => vi.clearAllMocks());

describe("UtilityModelPicker", () => {
  it("saves a picked chat model and clears back to each chat's own", async () => {
    setup(null);
    const user = userEvent.setup();
    const picker = await screen.findByRole("combobox", { name: "Model for chat titles" });
    await waitFor(() => expect(picker).not.toBeDisabled());
    fireEvent.click(picker);
    expect(screen.queryByRole("option", { name: /Embed/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: /^Beta\s*Provider$/ }));
    await waitFor(() =>
      expect(updateUtilityModel).toHaveBeenLastCalledWith({ data: { modelId: "b" } }),
    );
    await user.click(await screen.findByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(updateUtilityModel).toHaveBeenLastCalledWith({ data: { modelId: null } }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument(),
    );
  });
});
