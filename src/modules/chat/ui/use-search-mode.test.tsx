import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import { useSearchMode } from "./use-search-mode.ts";

vi.mock("~/modules/chat/server/functions.ts", () => ({
  listChatModels: vi.fn(),
}));
vi.mock("~/modules/tools/server/functions.ts", () => ({
  getWebSearchAvailability: vi.fn(),
}));

const model = (id: string, tools: boolean) => ({
  id,
  isDefault: id === "tool-model",
  providerId: "provider-1",
  providerName: "Provider One",
  modelKey: id,
  displayName: id,
  type: "chat" as const,
  enabled: true,
  contextLength: 128_000,
  capabilities: { reasoning: false, tools, vision: false, files: false },
});

const MODELS = [model("tool-model", true), model("plain-model", false)];

const setup = (options: { modelId?: string | null; searchEnabled?: boolean } = {}) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  client.setQueryData(["chat-models"], MODELS);
  client.setQueryData(["tools", "web-search", "availability"], {
    configured: true,
    enabled: options.searchEnabled ?? true,
  });

  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(({ modelId }) => useSearchMode(modelId), {
    wrapper,
    initialProps: { modelId: options.modelId === undefined ? "tool-model" : options.modelId },
  });
  return { client, ...hook };
};

describe("useSearchMode", () => {
  it("defaults on only when search is enabled and the model supports tools", () => {
    expect(setup().result.current.enabled).toBe(true);
    expect(setup({ searchEnabled: false }).result.current.enabled).toBe(false);
    expect(setup({ modelId: "plain-model" }).result.current.enabled).toBe(false);
    expect(setup({ modelId: null }).result.current.enabled).toBe(true);
    expect(setup({ modelId: "removed" }).result.current.enabled).toBe(true);
  });

  it("allows a per-message opt-out and resets to the enabled default", () => {
    const { result } = setup();

    act(() => result.current.setEnabled(false));
    expect(result.current.enabled).toBe(false);

    act(() => result.current.reset());
    expect(result.current.enabled).toBe(true);
  });

  it("preserves the preference while switching through an ineligible model", () => {
    const { result, rerender } = setup();

    rerender({ modelId: "plain-model" });
    expect(result.current.enabled).toBe(false);

    rerender({ modelId: "tool-model" });
    expect(result.current.enabled).toBe(true);

    act(() => result.current.setEnabled(false));
    rerender({ modelId: "plain-model" });
    rerender({ modelId: "tool-model" });
    expect(result.current.enabled).toBe(false);
  });

  it("reacts when admin availability changes without losing the preference", async () => {
    const { client, result } = setup();

    act(() => {
      client.setQueryData(["tools", "web-search", "availability"], {
        configured: true,
        enabled: false,
      });
    });
    await waitFor(() => expect(result.current.enabled).toBe(false));

    act(() => {
      client.setQueryData(["tools", "web-search", "availability"], {
        configured: true,
        enabled: true,
      });
    });
    await waitFor(() => expect(result.current.enabled).toBe(true));
  });
});
