import { describe, expect, it } from "vitest";
import type { ToolSource } from "../client/use-message-stream.ts";
import { inheritSources } from "./inherited-sources.ts";

const web = (index: number, url: string, extra: Partial<ToolSource> = {}): ToolSource =>
  ({ kind: "web", index, url, title: url, snippet: "", read: false, ...extra }) as ToolSource;

describe("inheritSources", () => {
  it("offers each message only what messages before it registered", () => {
    const [first, second, third] = inheritSources([
      [web(1, "https://a.dev")],
      [web(2, "https://b.dev")],
      [],
    ]);
    expect(first!(1)).toBeUndefined();
    expect(second!(1)).toMatchObject({ url: "https://a.dev" });
    expect(second!(2)).toBeUndefined();
    expect(third!(2)).toMatchObject({ url: "https://b.dev" });
    expect(third!(3)).toBeUndefined();
  });

  it("merges later observations of a number without leaking them backwards", () => {
    const lookups = inheritSources([
      [web(1, "https://a.dev", { title: "A" })],
      [web(1, "https://a.dev", { title: "A, read in full", read: true })],
      [],
    ]);
    // The second message sees the first observation only; the third sees both merged.
    expect(lookups[1]!(1)).toMatchObject({ read: false, title: "A" });
    expect(lookups[2]!(1)).toMatchObject({ read: true, title: "A, read in full" });
  });

  it("keeps one entry per number however long the conversation", () => {
    const messages = Array.from({ length: 2_000 }, (_, i) => [web(i + 1, `https://s${i}.dev`)]);
    const lookups = inheritSources(messages);
    expect(lookups[1_999]!(1)).toMatchObject({ url: "https://s0.dev" });
    expect(lookups[1_000]!(1_000)).toMatchObject({ url: "https://s999.dev" });
    expect(lookups[1_000]!(1_001)).toBeUndefined();
  });
});
