import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePreviewJson } from "./use-preview-json.ts";

const decode = (data: unknown) =>
  data && typeof data === "object" && "name" in data && typeof data.name === "string"
    ? { name: data.name }
    : null;

afterEach(() => vi.restoreAllMocks());

describe("usePreviewJson", () => {
  it("reads a new URL as loading until its own answer arrives, without a remount", async () => {
    const answers = new Map<string, (response: Response) => void>();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (url) => new Promise((resolve) => answers.set(String(url), resolve)),
    );
    const { result, rerender } = renderHook(({ url }) => usePreviewJson(url, decode), {
      initialProps: { url: "/a" },
    });
    expect(result.current).toEqual({ status: "loading" });
    answers.get("/a")!(Response.json({ name: "A" }));
    await waitFor(() =>
      expect(result.current).toEqual({ status: "ready", preview: { name: "A" } }),
    );

    rerender({ url: "/b" });
    expect(result.current).toEqual({ status: "loading" });
    answers.get("/b")!(Response.json({ name: "B" }));
    await waitFor(() =>
      expect(result.current).toEqual({ status: "ready", preview: { name: "B" } }),
    );
  });

  it("fails on an error status or a shape it does not know", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("no", { status: 403 }))
      .mockResolvedValueOnce(Response.json({ other: 1 }));
    const first = renderHook(() => usePreviewJson("/forbidden", decode));
    await waitFor(() => expect(first.result.current).toEqual({ status: "error" }));
    const second = renderHook(() => usePreviewJson("/odd", decode));
    await waitFor(() => expect(second.result.current).toEqual({ status: "error" }));
  });
});
