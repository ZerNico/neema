import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelEditDialog, type EditableModel } from "./model-edit-dialog.tsx";
import {
  listGroups,
  listModelAccess,
  updateModel,
  probeEmbeddingDimensions,
} from "../server/functions.ts";

vi.mock("../server/functions.ts", () => ({
  probeEmbeddingDimensions: vi.fn(),
  listGroups: vi.fn(),
  listGroupMemberships: vi.fn(),
  listModelAccess: vi.fn(),
  updateModel: vi.fn(),
}));

const updateMock = vi.mocked(updateModel);
const listGroupsMock = vi.mocked(listGroups);
const listAccessMock = vi.mocked(listModelAccess);

const groups = [
  {
    id: "g1",
    name: "Engineering",
    memberCount: 2,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "g2",
    name: "Design",
    memberCount: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

const model: EditableModel = {
  id: "m1",
  providerId: "provider-1",
  modelKey: "anthropic/tiny-chat",
  displayName: "Tiny Chat",
  type: "chat",
  contextLength: 128_000,
  embeddingDimensions: null,
  capabilities: { imageOutput: false, reasoning: false, tools: true, vision: false, files: false },
  pricing: { input: 2.5, output: 10 },
  enabled: true,
  access: "groups",
};

const renderDialog = (
  overrides: Partial<EditableModel> = {},
  accessRows: Array<{ modelId: string; groupId: string }> = [{ modelId: "m1", groupId: "g1" }],
) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["admin", "groups"], groups);
  client.setQueryData(["admin", "model-access"], accessRows);
  const onOpenChange = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <Suspense fallback={null}>
        <ModelEditDialog model={{ ...model, ...overrides }} open onOpenChange={onOpenChange} />
      </Suspense>
    </QueryClientProvider>,
  );
  return { onOpenChange, ...view };
};

beforeEach(() => {
  vi.clearAllMocks();
  updateMock.mockResolvedValue(undefined as never);
  listGroupsMock.mockResolvedValue(groups as never);
  listAccessMock.mockResolvedValue([{ modelId: "m1", groupId: "g1" }] as never);
});

describe("ModelEditDialog", () => {
  it("settles Detect and shows a rejected request", async () => {
    vi.mocked(probeEmbeddingDimensions).mockRejectedValueOnce(new Error("Connection refused"));
    renderDialog({ type: "embedding" });
    fireEvent.click(screen.getByRole("button", { name: "Detect" }));
    expect(await screen.findByText("Connection refused")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Detect" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Detect" })).not.toHaveAttribute("aria-busy");
  });

  it("initializes every setting and saves one complete model update", async () => {
    const { onOpenChange } = renderDialog();

    expect(await screen.findByLabelText("Display name")).toHaveValue("Tiny Chat");
    expect(screen.getByLabelText("Model ID")).toHaveValue("anthropic/tiny-chat");
    expect(screen.getByLabelText("Context length (optional)")).toHaveValue(128_000);
    expect(screen.getByLabelText("Input $/1M")).toHaveValue("2.5");
    expect(screen.getByLabelText("Output $/1M")).toHaveValue("10");
    expect(screen.getByText("Engineering")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Tiny Chat Plus" },
    });
    fireEvent.change(screen.getByLabelText("Context length (optional)"), {
      target: { value: "200000" },
    });
    fireEvent.change(screen.getByLabelText("Input $/1M"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Output $/1M"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("switch", { name: "Enabled" }));
    fireEvent.click(screen.getByRole("switch", { name: "Vision" }));
    fireEvent.change(screen.getByLabelText("Description (optional)"), {
      target: { value: "  Quick everyday answers " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith({
        data: {
          modelId: "m1",
          displayName: "Tiny Chat Plus",
          description: "Quick everyday answers",
          type: "chat",
          contextLength: 200_000,
          embeddingDimensions: null,
          capabilities: {
            imageOutput: false,
            reasoning: false,
            tools: true,
            vision: true,
            files: false,
          },
          pricing: { input: 3, output: 12 },
          enabled: false,
          access: "groups",
          groupIds: ["g1"],
        },
      }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("edits allowed reasoning levels as compact multiple choices", async () => {
    const user = userEvent.setup();
    renderDialog({
      capabilities: {
        imageOutput: false,
        reasoning: true,
        reasoningEfforts: ["high"],
        tools: true,
        vision: false,
        files: false,
      },
    });

    const high = screen.getByRole("button", { name: "High" });
    expect(high).toHaveAttribute("aria-pressed", "true");
    const off = screen.getByRole("button", { name: "Off" });
    expect(off).toHaveClass("bg-foreground/10");
    await user.click(off);
    await user.click(screen.getByRole("button", { name: "Low" }));
    await user.click(high);
    expect(high).toHaveAttribute("aria-pressed", "false");
    expect(high).toHaveTextContent("High");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith({
        data: expect.objectContaining({
          capabilities: {
            imageOutput: false,
            reasoning: true,
            reasoningEfforts: ["none", "low"],
            tools: true,
            vision: false,
            files: false,
          },
        }),
      }),
    );
  });

  it("shows only embedding settings and submits input-only pricing", async () => {
    renderDialog({
      type: "embedding",
      embeddingDimensions: 1536,
      capabilities: {
        imageOutput: false,
        reasoning: false,
        tools: false,
        vision: true,
        files: false,
      },
      pricing: { input: 0.02, output: null },
    });

    expect(await screen.findByLabelText("Max input tokens (optional)")).toHaveValue(128_000);
    expect(screen.getByLabelText("Dimensions (optional)")).toHaveValue(1536);
    expect(screen.getByRole("switch", { name: "Image input" })).toBeChecked();
    expect(screen.queryByText("Tool calling")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Output $/1M")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Dimensions (optional)"), { target: { value: "3072" } });
    fireEvent.change(screen.getByLabelText("Input $/1M"), { target: { value: "0.03" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: "embedding",
          embeddingDimensions: 3072,
          capabilities: {
            imageOutput: false,
            reasoning: false,
            tools: false,
            vision: true,
            files: false,
          },
          pricing: { input: 0.03, output: null },
        }),
      }),
    );
  });

  it("labels group-restricted access as Private and clears group ids when made Public", async () => {
    const user = userEvent.setup();
    renderDialog();

    (await screen.findByRole("combobox", { name: "Visibility" })).click();
    await user.click(await screen.findByRole("option", { name: "Public" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith({
        data: expect.objectContaining({ access: "public", groupIds: [] }),
      }),
    );
  });

  it("allows an admin-only Private staging state with no selected groups", async () => {
    const user = userEvent.setup();
    renderDialog({ access: "public" }, []);

    (await screen.findByRole("combobox", { name: "Visibility" })).click();
    await user.click(await screen.findByRole("option", { name: "Private" }));

    expect(
      await screen.findByText("Visible to admins only until a group is added."),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Add groups…")).toBeInTheDocument();
  });

  it("clears unknown numbers and refuses partial pricing or an invalid context length", async () => {
    const { unmount } = renderDialog();

    fireEvent.change(await screen.findByLabelText("Context length (optional)"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("Input $/1M"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Output $/1M"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith({
        data: expect.objectContaining({ contextLength: null, pricing: null }),
      }),
    );

    unmount();
    updateMock.mockClear();
    renderDialog();
    const save = await screen.findByRole("button", { name: "Save changes" });
    fireEvent.change(screen.getByLabelText("Input $/1M"), {
      target: { value: "" },
    });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Input $/1M"), {
      target: { value: "2.5" },
    });
    fireEvent.change(screen.getByLabelText("Context length (optional)"), {
      target: { value: "1.5" },
    });
    expect(save).toBeDisabled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and shows a save error", async () => {
    updateMock.mockRejectedValue(new Error("nope") as never);
    const { onOpenChange } = renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));

    const error = await screen.findByText("Could not save the model.");
    expect(error).toHaveAttribute("role", "alert");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("keeps the label and shows a spinner while saving", async () => {
    updateMock.mockImplementation(() => new Promise(() => {}) as never);
    renderDialog();

    const save = await screen.findByRole("button", { name: "Save changes" });
    fireEvent.click(save);

    await waitFor(() => expect(save).toHaveAttribute("aria-busy", "true"));
    expect(save).toBeDisabled();
    expect(save).toHaveTextContent("Save changes");
  });
});
