import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddModelDialog, EditProviderDialog } from "./provider-detail-page.tsx";
import {
  probeEmbeddingDimensions,
  createModel,
  testChatModel,
  updateProvider,
} from "../server/functions.ts";

vi.mock("../server/functions.ts", () => ({
  probeEmbeddingDimensions: vi.fn(),
  createModel: vi.fn(),
  testChatModel: vi.fn(),
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
            reasoningEfforts: ["low", "high"],
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
const testMock = vi.mocked(testChatModel);

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

  it("prefills catalog effort levels and allows editing the selection", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(["admin", "groups"], []);
    render(
      <QueryClientProvider client={client}>
        <AddModelDialog providerId="provider-1" open onOpenChange={vi.fn()} />
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Pick catalog model" }));
    expect(screen.getByRole("button", { name: "Low" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "High" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Low" }));
    await user.click(screen.getByRole("button", { name: "Add model" }));
    await waitFor(() => expect(createMock).toHaveBeenCalled());
    const capabilities = createMock.mock.lastCall?.[0].data.capabilities;
    expect(
      capabilities && "reasoningEfforts" in capabilities ? capabilities.reasoningEfforts : null,
    ).toEqual(["high"]);
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
    expect(screen.getByLabelText("Dimensions (optional)")).toHaveValue(null);

    probeMock.mockResolvedValueOnce({ ok: true, dimensions: 4096 });
    await user.click(screen.getByRole("button", { name: "Detect" }));
    await waitFor(() => expect(screen.getByLabelText("Dimensions (optional)")).toHaveValue(4096));
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

    expect(screen.getByLabelText("Max input tokens (optional)")).toHaveValue(128_000);
    expect(screen.getByLabelText("Dimensions (optional)")).toBeInTheDocument();
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
          description: null,
          type: "embedding",
          contextLength: 128_000,
          embeddingDimensions: null,
          capabilities: {
            imageOutput: false,
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

  it("tests a picked chat model before it is added and shows the outcome", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(["admin", "groups"], []);
    render(
      <QueryClientProvider client={client}>
        <AddModelDialog providerId="provider-1" open onOpenChange={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("button", { name: "Test" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pick catalog model" }));

    testMock.mockResolvedValueOnce({ ok: false, error: "model not found" });
    await user.click(screen.getByRole("button", { name: "Test" }));
    const failed = await screen.findByRole("status");
    expect(failed).toHaveTextContent("Didn’t work: model not found");
    expect(failed).toHaveClass("text-destructive");

    testMock.mockResolvedValueOnce({ ok: true, reply: "OK", latencyMs: 640 });
    await user.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Works: replied “OK” in 640ms."),
    );
    expect(testMock).toHaveBeenLastCalledWith({
      data: { providerId: "provider-1", modelKey: "catalog-model", format: null },
    });
    // Testing never adds the model.
    expect(createMock).not.toHaveBeenCalled();

    // Embedding models have Detect instead.
    screen.getByLabelText("Type").click();
    await user.click(await screen.findByRole("option", { name: "Embedding" }));
    expect(screen.queryByRole("button", { name: "Test" })).not.toBeInTheDocument();
  });
});

describe("AddModelDialog on Azure", () => {
  it("starts on Responses and takes the API a test switched to", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(["admin", "groups"], []);
    render(
      <QueryClientProvider client={client}>
        <AddModelDialog providerId="provider-1" presetId="azure" open onOpenChange={vi.fn()} />
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Pick catalog model" }));
    expect(screen.getByLabelText("API")).toHaveTextContent("Responses");

    testMock.mockResolvedValueOnce({
      ok: true,
      reply: "OK",
      latencyMs: 300,
      format: "chat-completions",
    });
    await user.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Works on Chat Completions: replied “OK” in 300ms.",
      ),
    );
    expect(testMock).toHaveBeenLastCalledWith({
      data: { providerId: "provider-1", modelKey: "catalog-model", format: "responses" },
    });
    expect(screen.getByLabelText("API")).toHaveTextContent("Chat Completions");

    await user.click(screen.getByRole("button", { name: "Add model" }));
    await waitFor(() => expect(createMock).toHaveBeenCalled());
    expect(createMock.mock.lastCall?.[0].data).toMatchObject({ format: "chat-completions" });
  });
});

describe("EditProviderDialog", () => {
  it("asks for both access key fields when Bedrock switches to signing", async () => {
    const user = userEvent.setup();
    const update = vi.mocked(updateProvider).mockResolvedValue(undefined as never);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EditProviderDialog
          provider={{
            id: "provider-1",
            name: "Bedrock",
            preset: "bedrock",
            baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
            settings: {},
          }}
          open
          onOpenChange={vi.fn()}
        />
      </QueryClientProvider>,
    );
    const save = screen.getByRole("button", { name: "Save changes" });
    // The stored endpoint shows as the region it came from.
    expect(screen.getByLabelText("Region")).toHaveValue("us-east-1");
    // Bedrock's API and reasoning field are fixed: signing in is its only setting.
    expect(screen.queryByLabelText("API")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Reasoning level field")).not.toBeInTheDocument();
    // The stored key stays when nothing is typed.
    expect(screen.getByLabelText("API key")).toHaveAttribute("placeholder", "Unchanged");
    expect(save).toBeEnabled();

    screen.getByLabelText("Sign in with").click();
    await user.click(await screen.findByRole("option", { name: "Access key" }));
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText("Access key ID"), "AKIAIOSFODNN7EXAMPLE");
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText("Secret access key"), "secret");
    expect(save).toBeEnabled();

    await user.click(save);
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.lastCall?.[0].data).toMatchObject({
      settings: { auth: "aws" },
      awsKeys: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "secret" },
    });
    expect(update.mock.lastCall?.[0].data).not.toHaveProperty("apiKey");
  });
});
