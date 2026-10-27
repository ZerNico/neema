import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_CAPABILITIES } from "~/modules/groups/policy.ts";
import { Composer } from "./composer.tsx";
import { composerText, setComposerText } from "./composer-test-utils.ts";

vi.mock("../server/functions.ts", () => ({
  listChatModels: vi.fn(),
  listConversations: vi.fn(),
  getConversationWithMessages: vi.fn(),
}));
vi.mock("~/modules/skills/server/functions.ts", () => ({ listSkills: vi.fn() }));
vi.mock("~/modules/tools/server/functions.ts", () => ({ getComposerAvailability: vi.fn() }));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const client = () => {
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queries.setQueryData(["capabilities"], ALL_CAPABILITIES);
  queries.setQueryData(["chat-models"], []);
  queries.setQueryData(["skills"], []);
  return queries;
};

describe("Composer cover", () => {
  it("turns the field into what covers it, keeps the bar, and hands the draft back unchanged", () => {
    const queries = client();
    const view = (cover?: { shown: boolean }) => (
      <QueryClientProvider client={queries}>
        <Composer
          onSend={vi.fn()}
          disabled={false}
          modelId={null}
          onModelChange={vi.fn()}
          searchEnabled={false}
          onSearchEnabledChange={vi.fn()}
          cover={cover && { shown: cover.shown, id: "question", render: () => <p>Asked here</p> }}
        />
      </QueryClientProvider>
    );
    const { rerender } = render(view());
    const field = screen.getByRole("textbox");
    setComposerText(field, "also cc Jonas");

    rerender(view({ shown: true }));
    // Its rise needs the app's LazyMotion; what matters here is which side is hidden.
    expect(screen.getByText("Asked here").closest("[hidden]")).toBeNull();
    // Hidden, not unmounted: the very editor comes back.
    expect(screen.queryByRole("textbox")).toBeNull();
    // The bar stays: an answer is sent with its model.
    expect(screen.getByRole("combobox")).toBeInTheDocument();

    rerender(view({ shown: false }));
    expect(screen.getByRole("textbox")).toBe(field);
    expect(composerText(field)).toBe("also cc Jonas");

    rerender(view());
    expect(screen.queryByText("Asked here")).toBeNull();
    expect(composerText(screen.getByRole("textbox"))).toBe("also cc Jonas");
  });

  it("keeps Stop where it is and puts the cover's buttons beside it", () => {
    const onStop = vi.fn();
    render(
      <QueryClientProvider client={client()}>
        <Composer
          onSend={vi.fn()}
          onStop={onStop}
          onQueue={vi.fn()}
          disabled={false}
          modelId={null}
          onModelChange={vi.fn()}
          searchEnabled={false}
          onSearchEnabledChange={vi.fn()}
          cover={{
            shown: true,
            id: "approval",
            render: (actions) =>
              actions ? createPortal(<button type="button">Next</button>, actions) : null,
          }}
        />
      </QueryClientProvider>,
    );
    expect(screen.getAllByRole("button", { name: "Stop generating" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    // What reaches only the next message is out of the way.
    expect(screen.queryByRole("button", { name: "Add files or tools" })).toBeNull();
  });

  it("takes the cover's buttons out of the bar while it is put aside", () => {
    const view = (shown: boolean) => (
      <QueryClientProvider client={client()}>
        <Composer
          onSend={vi.fn()}
          disabled={false}
          modelId={null}
          onModelChange={vi.fn()}
          searchEnabled={false}
          onSearchEnabledChange={vi.fn()}
          cover={{
            shown,
            id: "question",
            render: (actions) =>
              actions ? createPortal(<button type="button">Next</button>, actions) : null,
          }}
        />
      </QueryClientProvider>
    );
    const { rerender } = render(view(true));
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    rerender(view(false));
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });
});
