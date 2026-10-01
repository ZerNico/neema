import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { LazyToolFamily } from "../tool-load-schema.ts";
import { isAdvertised, prepareToolLoad } from "./tool-load.ts";

describe("load_tools", () => {
  it("loads offered families, names the rest, and only ever grows", async () => {
    const unlocked = new Set<LazyToolFamily>(["word"]);
    const group = prepareToolLoad({ offered: ["presentation", "word"], unlocked });
    const load = group.handlers["load_tools"] as (args: unknown) => Effect.Effect<unknown>;

    expect(
      await Effect.runPromise(load({ families: ["presentation", "spreadsheet", "nonsense"] })),
    ).toEqual({ loaded: ["presentation"], unavailable: ["spreadsheet", "nonsense"] });
    // A malformed call changes nothing rather than failing the generation.
    expect(await Effect.runPromise(load({ families: "presentation" }))).toEqual({
      loaded: [],
      unavailable: [],
    });
    expect([...unlocked].toSorted()).toEqual(["presentation", "word"]);
  });

  it("hides only offered families that are not loaded", () => {
    const offered: LazyToolFamily[] = ["presentation"];
    expect(isAdvertised("edit_presentation", offered, new Set())).toBe(false);
    expect(isAdvertised("edit_presentation", offered, new Set(["presentation"]))).toBe(true);
    // Not offered as lazy: whoever offers it decides, so it stays advertised.
    expect(isAdvertised("edit_spreadsheet", offered, new Set())).toBe(true);
    expect(isAdvertised("web_search", offered, new Set())).toBe(true);
  });
});
