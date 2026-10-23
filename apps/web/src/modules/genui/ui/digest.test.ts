import { describe, expect, it } from "vitest";
import { NO_LOOKUPS, type UiLookups } from "~/modules/chat/assistant-output.ts";
import type { ValidNode } from "../catalog.ts";
import { routeKey } from "../extract.ts";
import { DIGEST_LIMITS, digestTree } from "./digest.ts";

const el = (tag: string, props: Record<string, unknown>, children: ValidNode["children"] = []) =>
  ({ tag, props, children }) as ValidNode;

describe("digestTree", () => {
  it("says what each control shows, in reading order", () => {
    const tree = [
      el("card", { title: "Loan" }, [
        el("slider", { label: "Amount", min: 0, max: 10, value: 0.1 + 0.2 }),
        el("select", {
          label: "Term",
          options: [
            { label: "Ten years", value: 10 },
            { label: "Twenty years", value: 20 },
          ],
          value: 20,
        }),
        el("switch", { label: "Fixed rate", checked: true }),
        el("stat", { label: "Monthly", value: "€1,043" }),
        el("progress", { label: "Paid off", value: 40 }),
        el("datepicker", { label: "First payment", value: "2026-11-01" }),
      ]),
      el("tabs", { value: "b" }, [
        el("tab", { label: "First", value: "a" }),
        el("tab", { label: "Second", value: "b" }),
      ]),
    ];
    expect(digestTree(tree, NO_LOOKUPS)).toBe(
      [
        "Amount: 0.3",
        "Term: Twenty years",
        "Fixed rate: on",
        "Monthly: €1,043",
        "Paid off: 40%",
        "First payment: 2026-11-01",
        "Tab open: Second",
      ].join("\n"),
    );
  });

  it("scores a quiz and counts checked steps", () => {
    const tree = [
      el("quiz", { title: "Capitals", answers: ["Lisbon", "Bern", null] }, [
        el("question", { options: ["Lisbon", "Porto"], answer: "Lisbon" }, ["Portugal?"]),
        el("question", { options: ["Zurich", "Bern"], answer: "Zurich" }, ["Not really"]),
        el("question", { options: ["Oslo"], answer: "Oslo" }, ["Norway?"]),
      ]),
      el("steps", { checkable: true, done: [0, 2] }, [
        el("step", { title: "Soak" }),
        el("step", { title: "Boil" }),
        el("step", { title: "Rest" }),
      ]),
      el("wizard", { current: 1 }, [
        el("step", { title: "Frame" }),
        el("step", { title: "Wheels" }),
      ]),
    ];
    expect(digestTree(tree, NO_LOOKUPS)).toBe(
      ["Capitals: 2 of 3 answered, 1 right", "Steps: 2 of 3 done", "Step 2 of 2: Wheels"].join(
        "\n",
      ),
    );
  });

  it("gives a map's routes with their distances and legs, and places not found", () => {
    const stops = ["Bernau", "Wittenberg", "Leipzig"];
    const lookups: UiLookups = {
      ...NO_LOOKUPS,
      places: {
        Bernau: { status: "resolved", lat: 52.67, lng: 13.58 },
        Atlantis: { status: "unavailable" },
      },
      routes: {
        [routeKey({ mode: "bike", stops })]: {
          status: "resolved",
          path: [[13.58, 52.67]],
          distance: 225_000,
          duration: 36_120,
          legs: [
            { distance: 120_000, duration: 19_000 },
            { distance: 105_000, duration: 17_120 },
          ],
        },
      },
    };
    const tree = [
      el("map", { label: "Bernau to Leipzig", selected: "start" }, [
        el("pin", { id: "start", place: "Bernau", label: "Start" }),
        el("pin", { place: "Atlantis" }),
        el("route", { mode: "bike", stops }),
      ]),
    ];
    expect(digestTree(tree, lookups)).toBe(
      [
        "Bernau to Leipzig: selected Start",
        "Bike route Bernau → Wittenberg → Leipzig: 225 km · 10 h 2 min (legs: 120 km · 5 h 17 min, 105 km · 4 h 45 min)",
        "Not found on the map: Atlantis",
      ].join("\n"),
    );
  });

  it("is null for a block with nothing to report, and drops the longest lines past its budget", () => {
    expect(digestTree([el("text", {}, ["Just prose"])], NO_LOOKUPS)).toBeNull();
    const fields = Array.from({ length: 16 }, (_, i) =>
      el("input", { label: `Field ${i}`, value: "x".repeat(i === 3 ? 190 : 60) }),
    );
    const digest = digestTree(fields, NO_LOOKUPS)!;
    expect(digest.length).toBeLessThanOrEqual(DIGEST_LIMITS.chars);
    expect(digest).not.toContain("Field 3:");
    expect(digest).toContain("Field 0:");
  });
});
