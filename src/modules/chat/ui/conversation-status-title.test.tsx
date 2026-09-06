import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppMotionProvider } from "~/ui/motion.tsx";
import { ConversationStatusTitle } from "./conversation-status-title.tsx";
import { createTitleRevealRegistry } from "./conversation-title.tsx";

afterEach(() => vi.unstubAllGlobals());

function setup(branched = false, generating = false) {
  const registry = createTitleRevealRegistry();
  const tree = (busy: boolean) => (
    <AppMotionProvider>
      <a href="/chat/example" className="flex">
        <ConversationStatusTitle
          conversationId="example"
          title="Example chat"
          registry={registry}
          generating={busy}
          branched={branched}
        />
      </a>
    </AppMotionProvider>
  );
  const view = render(tree(generating));
  const title = screen.getByText("Example chat");
  const link = screen.getByRole("link");
  const slot = link.firstElementChild as HTMLElement;
  return { ...view, title, link, slot, update: (busy: boolean) => view.rerender(tree(busy)) };
}

describe("conversation status in sidebar and chats list", () => {
  it("animates idle → generating → idle without replacing the title or leaving a gap", async () => {
    const { title, link, slot, update } = setup();
    expect(slot.style.width).toBe("0px");
    update(true);
    expect(screen.getByRole("status", { name: "Generating" })).toBeInTheDocument();
    expect(screen.getByText("Example chat")).toBe(title);
    expect(screen.getByRole("link")).toBe(link);
    await waitFor(() => expect(slot.style.width).toBe("24px"));
    update(false);
    expect(screen.queryByRole("status")).toBeNull();
    await waitFor(() => expect(slot.style.width).toBe("0px"));
  });

  it("starts settled and swaps branch and busy within the same slot", async () => {
    const { slot, update } = setup(true);
    expect(slot.style.width).toBe("24px");
    update(true);
    expect(screen.getByRole("link")).toHaveAccessibleName("Generating Example chat");
    update(false);
    expect(screen.getByRole("link")).toHaveAccessibleName("Branched conversation Example chat");
    await waitFor(() => expect(slot.querySelector("[inert]")).toBeNull());
    expect(slot.style.width).toBe("24px");
  });

  it("remeasures overflow only after the slot stops resizing", async () => {
    const registry = createTitleRevealRegistry();
    let measured = 0;
    const listeners = new Set<ResizeObserverCallback>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private notify: ResizeObserverCallback) {
          listeners.add(notify);
        }
        observe() {}
        disconnect() {
          listeners.delete(this.notify);
        }
      },
    );
    const tree = (generating: boolean) => (
      <AppMotionProvider>
        <a href="/chat/example">
          <ConversationStatusTitle
            conversationId="example"
            title="A long conversation title"
            registry={registry}
            createdAt="2026-09-06"
            generating={generating}
            branched={false}
          />
        </a>
      </AppMotionProvider>
    );
    const { rerender, container } = render(tree(false));
    const viewport = container.querySelector("[data-title-state]")!;
    const text = container.querySelector("[data-title-text]")!;
    Object.defineProperty(viewport, "clientWidth", {
      configurable: true,
      get: () => {
        measured++;
        return 100;
      },
    });
    Object.defineProperty(text, "scrollWidth", { configurable: true, value: 220 });
    rerender(tree(true));
    const before = measured;
    act(() => listeners.forEach((notify) => notify([], {} as ResizeObserver)));
    expect(measured).toBe(before);
    await waitFor(() => expect(viewport).toHaveAttribute("data-title-overflowing", "true"));
    expect(measured).toBe(before + 1);
  });
});
