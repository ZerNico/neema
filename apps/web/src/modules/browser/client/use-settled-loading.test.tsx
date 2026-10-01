import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSettledLoading } from "./use-settled-loading.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("turns on at once and off only once loading has stayed off", () => {
  const { result, rerender } = renderHook(({ loading }) => useSettledLoading(loading, 400), {
    initialProps: { loading: false },
  });
  expect(result.current).toBe(false);
  rerender({ loading: true });
  expect(result.current).toBe(true);
  // A page that stops and starts again while finishing never shows "done".
  rerender({ loading: false });
  act(() => vi.advanceTimersByTime(300));
  rerender({ loading: true });
  rerender({ loading: false });
  act(() => vi.advanceTimersByTime(300));
  expect(result.current).toBe(true);
  act(() => vi.advanceTimersByTime(100));
  expect(result.current).toBe(false);
});
