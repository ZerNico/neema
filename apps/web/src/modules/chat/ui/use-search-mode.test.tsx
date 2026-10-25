import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import { useSearchMode } from "./use-search-mode.ts";

vi.mock("~/modules/tools/server/functions.ts", () => ({
  getComposerAvailability: vi.fn(),
}));

const setup = (options: { searchEnabled?: boolean } = {}) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  client.setQueryData(["tools", "availability"], (current: object | undefined) => ({
    ...current,
    search: {
      configured: true,
      enabled: options.searchEnabled ?? true,
    },
  }));

  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useSearchMode(), { wrapper });
  return { client, ...hook };
};

describe("useSearchMode", () => {
  it("defaults on exactly when the admin has search enabled", () => {
    expect(setup().result.current.enabled).toBe(true);
    expect(setup({ searchEnabled: false }).result.current.enabled).toBe(false);
  });

  it("allows a per-message opt-out and resets to the enabled default", () => {
    const { result } = setup();

    act(() => result.current.setEnabled(false));
    expect(result.current.enabled).toBe(false);

    act(() => result.current.reset());
    expect(result.current.enabled).toBe(true);
  });

  it("reacts when admin availability changes without losing the preference", async () => {
    const { client, result } = setup();

    act(() => {
      client.setQueryData(["tools", "availability"], (current: object | undefined) => ({
        ...current,
        search: {
          configured: true,
          enabled: false,
        },
      }));
    });
    await waitFor(() => expect(result.current.enabled).toBe(false));

    act(() => {
      client.setQueryData(["tools", "availability"], (current: object | undefined) => ({
        ...current,
        search: {
          configured: true,
          enabled: true,
        },
      }));
    });
    await waitFor(() => expect(result.current.enabled).toBe(true));
  });
});
