import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddModelDialog } from "./provider-detail-page.tsx";
import { createModel } from "../server/functions.ts";

vi.mock("../server/functions.ts", () => ({
  createModel: vi.fn(),
  createProvider: vi.fn(),
  deleteModel: vi.fn(),
  deleteProvider: vi.fn(),
  listModels: vi.fn(),
  listProviders: vi.fn(),
  updateProvider: vi.fn(),
}));

vi.mock("./model-combobox.tsx", () => ({
  ModelCombobox: ({ onPick }: { onPick: (model: unknown) => void }) => (
    <button
      type="button"
      onClick={() =>
        onPick({
          id: "catalog-model",
          name: "Catalog Model",
          type: "chat",
          contextLength: 128_000,
          capabilities: {
            reasoning: true,
            tools: true,
            vision: false,
            files: false,
          },
          pricing: { input: 1, output: 3 },
        })
      }
    >
      Pick catalog model
    </button>
  ),
}));

const createMock = vi.mocked(createModel);

beforeEach(() => {
  vi.clearAllMocks();
  createMock.mockResolvedValue(undefined as never);
});

describe("AddModelDialog", () => {
  it("allows overriding the inferred type of a catalog model", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(["admin", "groups"], []);

    render(
      <QueryClientProvider client={client}>
        <AddModelDialog providerId="provider-1" open onOpenChange={vi.fn()} />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Pick catalog model" }));

    const typeSelect = screen.getByLabelText("Type");
    expect(typeSelect).toHaveTextContent("chat");
    typeSelect.click();
    expect(screen.queryByRole("option", { name: "image" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "audio" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "embedding" }));

    expect(screen.getByLabelText("Max input tokens")).toHaveValue(128_000);
    expect(screen.getByLabelText("Dimensions")).toBeInTheDocument();
    expect(screen.getByLabelText("Input $/1M")).toHaveValue("1");
    expect(screen.queryByLabelText("Output $/1M")).not.toBeInTheDocument();
    expect(screen.queryByText("Tool calling")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add model" }));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        data: {
          providerId: "provider-1",
          modelKey: "catalog-model",
          displayName: "Catalog Model",
          type: "embedding",
          contextLength: 128_000,
          embeddingDimensions: null,
          capabilities: {
            reasoning: false,
            tools: false,
            vision: false,
            files: false,
          },
          pricing: { input: 1, output: null },
          enabled: true,
          access: "public",
          groupIds: [],
        },
      }),
    );
  });
});
