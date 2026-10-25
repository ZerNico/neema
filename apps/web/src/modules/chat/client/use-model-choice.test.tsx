import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it } from "vitest";
import { useModelChoice } from "./use-model-choice.ts";

const models = [
  { id: "alpha", isDefault: true },
  { id: "beta", isDefault: false },
  { id: "gamma", isDefault: false },
];

const renderChoice = (suggested: string | null) => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["chat-models"], models);
  return renderHook(({ suggested: next }) => useModelChoice(next), {
    initialProps: { suggested },
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
};

it("follows a chosen agent's model until the person picks, and again once the pick is cleared", () => {
  const { result, rerender } = renderChoice(null);
  expect(result.current.modelId).toBe("alpha");
  rerender({ suggested: "beta" });
  expect(result.current.modelId).toBe("beta");
  act(() => result.current.pick("gamma"));
  rerender({ suggested: "alpha" });
  expect(result.current.modelId).toBe("gamma");
  expect(result.current.picked).toBe("gamma");
  // What another agent's choice does: its model applies again.
  act(() => result.current.pick(null));
  expect(result.current.modelId).toBe("alpha");
});

it("falls back to the chat's own model when a pick is no longer offered", () => {
  const { result } = renderChoice("beta");
  act(() => result.current.pick("removed"));
  expect(result.current.modelId).toBe("beta");
});
