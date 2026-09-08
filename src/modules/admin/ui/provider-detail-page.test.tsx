import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddModelDialog } from "./provider-detail-page.tsx";
import { probeEmbeddingDimensions, createModel } from "../server/functions.ts";

vi.mock("../server/functions.ts", () => ({
  probeEmbeddingDimensions: vi.fn(),
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
const probeMock = vi.mocked(probeEmbeddingDimensions);

beforeEach(() => {
  vi.clearAllMocks();
  createMock.mockResolvedValue(undefined as never);
});

describe("AddModelDialog", () => {
  it("shows no model settings until something is actually picked", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(["admin", "groups"], []);
    render(
      <QueryClientProvider client={client}>
        <AddModelDialog providerId="provider-1" open onOpenChange={vi.fn()} />
      </QueryClientProvider>,
    );
    // Nothing chosen: no type selector, no toggles, and Add stays disabled.
    expect(screen.queryByLabelText("Type")).not.toBeInTheDocument();
    expect(screen.queryByText("Tool calling")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add model" })).toBeDisabled();
    // Picking is what opens the settings.
    await user.click(screen.getByRole("button", { name: "Pick catalog model" }));
    expect(screen.getByLabelText("Type")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add model" })).toBeEnabled();
  });

  it("detects an embedding model's dimensions from the provider and reports failures inline", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(["admin", "groups"], []);
    render(
      <QueryClientProvider client={client}>
        <AddModelDialog providerId="provider-1" open onOpenChange={vi.fn()} />
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Pick catalog model" }));
    screen.getByLabelText("Type").click();
    await user.click(await screen.findByRole("option", { name: "Embedding" }));

    probeMock.mockResolvedValueOnce({ ok: false, error: "the model did not return an embedding" });
    await user.click(screen.getByRole("button", { name: "Detect" }));
    expect(await screen.findByText("the model did not return an embedding")).toBeInTheDocument();
    expect(screen.getByLabelText("Dimensions")).toHaveValue(null);

    probeMock.mockResolvedValueOnce({ ok: true, dimensions: 4096 });
    await user.click(screen.getByRole("button", { name: "Detect" }));
    await waitFor(() => expect(screen.getByLabelText("Dimensions")).toHaveValue(4096));
    expect(probeMock).toHaveBeenLastCalledWith({
      data: { providerId: "provider-1", modelKey: "catalog-model" },
    });
    expect(screen.queryByText("the model did not return an embedding")).not.toBeInTheDocument();
  });

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
    expect(typeSelect).toHaveTextContent("Chat");
    typeSelect.click();
    expect(screen.queryByRole("option", { name: "Image" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Audio" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "Embedding" }));

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
