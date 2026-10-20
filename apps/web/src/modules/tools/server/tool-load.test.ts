import { Effect } from "effect";
import { Tool } from "effect/unstable/ai";
import { describe, expect, it } from "vitest";
import type { LazyToolFamily, LoadableToolFamily } from "../tool-load-schema.ts";
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

  it("loads one integration's tools by its family, and offers only what this attempt has", async () => {
    const unlocked = new Set<LoadableToolFamily>();
    const group = prepareToolLoad({ offered: ["word", "integration:trello"], unlocked });
    const load = group.handlers["load_tools"] as (args: unknown) => Effect.Effect<unknown>;
    expect(
      await Effect.runPromise(load({ families: ["integration:trello", "integration:jira"] })),
    ).toEqual({
      loaded: ["integration:trello"],
      unavailable: ["integration:jira"],
    });
    expect(isAdvertised("int_trello__read_board", ["integration:trello"], unlocked)).toBe(true);
    // An integration offered as it is, never lazily, is always shown.
    expect(isAdvertised("int_linear__search", ["integration:trello"], new Set())).toBe(true);
    const schema = Tool.getJsonSchema(group.toolkit.tools["load_tools"]!) as {
      properties: { families: { items: { enum: string[] } } };
    };
    expect(schema.properties.families.items.enum).toEqual(["word", "integration:trello"]);
  });
});
