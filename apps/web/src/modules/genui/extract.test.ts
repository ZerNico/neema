import { describe, expect, it } from "vitest";
import {
  IMAGE_QUERY_LIMITS,
  MAP_LOOKUP_LIMITS,
  blockMapLookups,
  extractImageQueries,
  quotedStrings,
  routeKey,
} from "./extract.ts";

describe("extractImageQueries", () => {
  it("collects literal queries from closed blocks in order, once each", () => {
    const content = [
      "```ui",
      '<image query="7 speed  cassette"/>',
      '{#if open}<images query={["hub gear", `derailleur`]}/>{/if}',
      "```",
      "text",
      "```ui",
      '<image query="hub gear"/>',
      "```",
    ].join("\n");
    expect(extractImageQueries(content)).toEqual(["7 speed cassette", "hub gear", "derailleur"]);
  });

  it("skips computed queries and open fences", () => {
    expect(extractImageQueries('```ui\n<image query={name + " photo"}/>\n```')).toEqual([]);
    expect(extractImageQueries('```ui\n<image query="still streaming"/>')).toEqual([]);
  });

  it("caps queries per answer", () => {
    const tags = Array.from({ length: 12 }, (_, i) => `<image query="q${i}"/>`).join("");
    expect(extractImageQueries(`\`\`\`ui\n${tags}\n\`\`\``)).toHaveLength(
      IMAGE_QUERY_LIMITS.queriesPerAnswer,
    );
  });
});

describe("blockMapLookups", () => {
  it("finds literal places and routes, and leaves computed ones to the block", () => {
    const code = [
      "<map>",
      '  <pin id="ferry" place="Ferry  Building, San Francisco" label="Ferry"/>',
      '  <pin place={"Coit Tower"}/>',
      '  <pin lat={37.8} lng={-122.4} label="Given"/>',
      "  {#each spots as s}<pin place={s.name}/>{/each}",
      '  <route mode="walk" stops={["Ferry Building, San Francisco", { lat: 37.8024, lng: -122.4058 }]}/>',
      '  <route mode="fly" stops={["A", "B"]}/>',
      "  <route stops={names}/>",
      '  <route stops={["Only one"]}/>',
      "</map>",
    ].join("\n");
    const { places, routes } = blockMapLookups(code);
    expect(places).toEqual([
      "Ferry Building, San Francisco",
      "Coit Tower",
      "Ferry Building, San Francisco",
    ]);
    expect(routes).toEqual([
      {
        mode: "walk",
        stops: ["Ferry Building, San Francisco", { lat: 37.8024, lng: -122.4058 }],
      },
    ]);
  });

  it("drives by default and names a route the same however it was spaced", () => {
    const [route] = blockMapLookups('<route stops={["Berlin ", "Potsdam"]}/>').routes;
    expect(route?.mode).toBe("drive");
    expect(routeKey(route!)).toBe(routeKey({ mode: "drive", stops: ["Berlin", "Potsdam"] }));
    expect(routeKey({ mode: "drive", stops: [{ lat: 52.5200001, lng: 13.4 }, "Potsdam"] })).toBe(
      'drive:[[52.52,13.4],"Potsdam"]',
    );
  });

  it("keeps at most ten stops of a route", () => {
    const stops = JSON.stringify(Array.from({ length: 14 }, (_, i) => `Stop ${i}`));
    const [route] = blockMapLookups(`<route mode="bike" stops={${stops}}/>`).routes;
    expect(route?.stops).toHaveLength(MAP_LOOKUP_LIMITS.stopsPerRoute);
  });
});

describe("quotedStrings", () => {
  it("collects attribute values and script literals of every quote, normalised", () => {
    const code = `<script>
  let stops = $state([{ place: "Museum  Barberini, Potsdam" }, { place: 'Sanssouci' }]);
  const dock = \`Lange Brücke\`;
  const said = "say \\"hi\\"";
</script>
<pin place="Potsdam Hauptbahnhof"/>`;
    expect([...quotedStrings(code)].toSorted()).toEqual(
      ["Lange Brücke", "Museum Barberini, Potsdam", "Potsdam Hauptbahnhof", "Sanssouci", 'say "hi"'].toSorted(),
    );
  });

  it("skips templates with interpolation, whose text the reader may supply", () => {
    expect(quotedStrings("const q = `${typed} street`;").has(" street")).toBe(false);
  });
});
