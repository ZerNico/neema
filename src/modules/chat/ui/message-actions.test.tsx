import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppMotionProvider } from "~/ui/motion.tsx";
import { MessageActions } from "./message-actions.tsx";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps Copy's button and restarts then cleans its feedback timer", async () => {
  vi.useFakeTimers();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const { unmount } = render(
    <AppMotionProvider>
      <MessageActions sources={[]} content="A finding[^1]" />
    </AppMotionProvider>,
  );
  const button = screen.getByRole("button", { name: "Copy" });
  await act(async () => {
    fireEvent.click(button);
  });
  expect(writeText).toHaveBeenCalledWith("A finding");
  expect(screen.getByRole("button", { name: "Copied" })).toBe(button);
  act(() => vi.advanceTimersByTime(1000));
  await act(async () => {
    fireEvent.click(button);
  });
  act(() => vi.advanceTimersByTime(600));
  expect(screen.getByRole("button", { name: "Copied" })).toBe(button);
  act(() => vi.advanceTimersByTime(900));
  expect(screen.getByRole("button", { name: "Copy" })).toBe(button);
  await act(async () => {
    fireEvent.click(button);
  });
  const clear = vi.spyOn(globalThis, "clearTimeout");
  unmount();
  expect(clear).toHaveBeenCalled();
});

it("does not schedule feedback when a pending clipboard write resolves after unmount", async () => {
  let resolve!: () => void;
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    },
  });
  const { unmount } = render(
    <AppMotionProvider>
      <MessageActions sources={[]} content="Finding" />
    </AppMotionProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  unmount();
  const timeout = vi.spyOn(globalThis, "setTimeout");
  await act(async () => resolve());
  expect(timeout).not.toHaveBeenCalled();
  timeout.mockRestore();
});
