import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ToolSource } from "../client/use-message-stream.ts";
import { useHeldSources } from "./citations.ts";

const source = (index: number, title = `Page ${index}`): ToolSource => ({
  index,
  url: `https://example.com/${index}`,
  title,
  snippet: "",
  read: false,
  kind: "web",
});

describe("useHeldSources", () => {
  it("keeps the array while each tick selects the same sources", () => {
    const first = [source(1)];
    const { result, rerender } = renderHook(({ sources }) => useHeldSources(sources), {
      initialProps: { sources: first },
    });
    rerender({ sources: [source(1)] });
    expect(result.current).toBe(first);
  });

  it("hands over a new citation or a fuller title at once", () => {
    const { result, rerender } = renderHook(({ sources }) => useHeldSources(sources), {
      initialProps: { sources: [source(1)] },
    });
    const cited = [source(1), source(2)];
    rerender({ sources: cited });
    expect(result.current).toBe(cited);
    const retitled = [source(1, "Page 1, read"), source(2)];
    rerender({ sources: retitled });
    expect(result.current).toBe(retitled);
  });
});
