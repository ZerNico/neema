import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChatInput } from "./chat-input.tsx";
import { Composer } from "./composer.tsx";

function renderWithQueries(ui: ReactNode) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    ["chat-models"],
    [
      {
        id: "model-1",
        displayName: "Test Model",
        contextLength: 128_000,
        capabilities: { reasoning: false, tools: true, vision: false },
      },
    ],
  );
  queryClient.setQueryData(["tools", "web-search", "availability"], {
    configured: true,
    enabled: true,
  });

  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("ChatInput", () => {
  it("keeps the next-message draft editable while submission is disabled", () => {
    renderWithQueries(
      <Composer
        onSend={vi.fn()}
        disabled
        modelId="model-1"
        onModelChange={vi.fn()}
        searchEnabled={false}
        onSearchEnabledChange={vi.fn()}
      />,
    );

    const textarea = screen.getByRole("textbox");
    expect(textarea).not.toBeDisabled();
    fireEvent.change(textarea, { target: { value: "next message" } });
    expect(textarea).toHaveValue("next message");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("can disable the bottom textarea specifically during inline editing", () => {
    renderWithQueries(
      <Composer
        onSend={vi.fn()}
        disabled
        textareaDisabled
        modelId="model-1"
        onModelChange={vi.fn()}
        searchEnabled={false}
        onSearchEnabledChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("textbox")).toBeDisabled();
  });

  it("does not submit a stale model id from the keyboard", () => {
    const onSubmit = vi.fn();
    const onModelChange = vi.fn();
    renderWithQueries(
      <ChatInput
        value="hello"
        onValueChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        modelId="disabled-model"
        onModelChange={onModelChange}
        searchEnabled={false}
        onSearchEnabledChange={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onModelChange).toHaveBeenCalledWith("model-1");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
});
