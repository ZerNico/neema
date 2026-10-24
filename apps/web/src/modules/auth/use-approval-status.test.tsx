import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FakeEventSource } from "../../../tests/fixtures/event-source.ts";
import { useApprovalStatus } from "./use-approval-status.ts";

const status = vi.hoisted(() => vi.fn<() => Promise<"pending" | "approved" | "rejected" | null>>());
vi.mock("./client.ts", () => ({
  meQuery: {
    queryKey: ["me"],
    queryFn: async () => {
      const approval = await status();
      return approval === null ? null : { approval };
    },
    staleTime: Infinity,
  },
}));

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  status.mockReset().mockResolvedValue("pending");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const renderStatus = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const hook = renderHook(useApprovalStatus, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...hook, source: FakeEventSource.instances.at(-1)! };
};

it("does not poll while waiting and refreshes on an approval wakeup", async () => {
  const { result, source, unmount } = renderStatus();
  await waitFor(() => expect(result.current.data).toBe("pending"));
  expect(source.url).toBe("/api/approval");
  vi.useFakeTimers();
  await act(() => vi.advanceTimersByTimeAsync(120_000));
  expect(status).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
  status.mockResolvedValue("approved");
  act(() => source.emit("approval"));
  await waitFor(() => expect(result.current.data).toBe("approved"));
  unmount();
  expect(source.close).toHaveBeenCalledOnce();
});

it("keeps an approval event that arrives during an older status request", async () => {
  let release!: (value: "pending") => void;
  status.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const { result, source } = renderStatus();
  await waitFor(() => expect(status).toHaveBeenCalledTimes(1));
  status.mockResolvedValue("approved");
  act(() => source.emit("approval"));
  expect(status).toHaveBeenCalledTimes(1);
  await act(async () => {
    release("pending");
  });
  await waitFor(() => expect(result.current.data).toBe("approved"));
  expect(status).toHaveBeenCalledTimes(2);
});

it("rechecks rejected and expired sessions after subscription or connection errors", async () => {
  const { result, source } = renderStatus();
  await waitFor(() => expect(result.current.data).toBe("pending"));
  status.mockResolvedValue("rejected");
  act(() => source.emit("approval"));
  await waitFor(() => expect(result.current.data).toBe("rejected"));
  status.mockResolvedValue(null);
  act(() => source.emit("error"));
  await waitFor(() => expect(result.current.data).toBeNull());
});
