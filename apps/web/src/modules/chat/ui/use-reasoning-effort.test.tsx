import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useReasoningEffort } from "./use-reasoning-effort.ts";

vi.mock("~/modules/chat/server/functions.ts", () => ({ listChatModels: vi.fn() }));

const models = [
  { id: "reasoning", reasoningEfforts: ["low", "high", "none"] },
  { id: "other", reasoningEfforts: ["medium"] },
];

function Probe() {
  const [modelId, setModelId] = useState("reasoning");
  const { effort, setEffort } = useReasoningEffort(modelId);
  return (
    <>
      <output data-testid="effort">{effort ?? "default"}</output>
      <button onClick={() => setEffort("high")}>High</button>
      <button
        onClick={() => {
          setModelId("other");
          setEffort("medium", "other");
        }}
      >
        Borrow other model
      </button>
      <button
        onClick={() => {
          setEffort(null);
          setModelId("other");
        }}
      >
        Other model
      </button>
      <button
        onClick={() => {
          setEffort(null);
          setModelId("reasoning");
        }}
      >
        Original model
      </button>
    </>
  );
}

describe("reasoning effort selection", () => {
  it("drops an effort the next model cannot accept", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(["chat-models"], models);
    render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );

    act(() => screen.getByRole("button", { name: "High" }).click());
    expect(screen.getByTestId("effort")).toHaveTextContent("high");
    act(() => screen.getByRole("button", { name: "Other model" }).click());
    expect(screen.getByTestId("effort")).toHaveTextContent("default");
    act(() => screen.getByRole("button", { name: "Original model" }).click());
    expect(screen.getByTestId("effort")).toHaveTextContent("default");
  });

  it("sets an effort for a borrowed model in the same render", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(["chat-models"], models);
    render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );

    act(() => screen.getByRole("button", { name: "Borrow other model" }).click());
    expect(screen.getByTestId("effort")).toHaveTextContent("medium");
  });

  it("drops a selected level removed by an admin", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(["chat-models"], models);
    render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );

    act(() => screen.getByRole("button", { name: "High" }).click());
    act(() =>
      client.setQueryData(["chat-models"], [{ id: "reasoning", reasoningEfforts: ["low"] }]),
    );
    await waitFor(() => expect(screen.getByTestId("effort")).toHaveTextContent("default"));
  });
});
