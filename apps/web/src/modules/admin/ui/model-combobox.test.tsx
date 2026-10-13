import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModelCombobox } from "./model-combobox.tsx";
import { fetchProviderCatalog } from "../server/functions.ts";

vi.mock("../server/functions.ts", () => ({ fetchProviderCatalog: vi.fn() }));

describe("ModelCombobox", () => {
  it("offers a model that both chats and draws once per type", async () => {
    vi.mocked(fetchProviderCatalog).mockResolvedValue({
      ok: true,
      models: [
        {
          id: "google/gemini-image",
          name: "Nano Banana",
          type: "chat",
          contextLength: 32_000,
          capabilities: { reasoning: false, tools: false },
          pricing: null,
        },
        {
          id: "google/gemini-image",
          name: "Nano Banana",
          type: "image",
          contextLength: null,
          capabilities: { reasoning: false, tools: false },
          pricing: null,
          imageFamily: "openrouter-image",
        },
      ],
    } as never);
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ModelCombobox providerId="p1" onPick={onPick} />
      </QueryClientProvider>,
    );
    await user.click(await screen.findByPlaceholderText("Search models or type an ID…"));
    await user.keyboard("gemini");
    expect(await screen.findByRole("option", { name: /Nano Banana · 32k ctx · Chat/ })).toBeTruthy();
    await user.click(screen.getByRole("option", { name: /Nano Banana · Image/ }));
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ type: "image", imageFamily: "openrouter-image" }),
    );
  });
});
