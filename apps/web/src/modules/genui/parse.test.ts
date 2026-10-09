import { describe, expect, it } from "vitest";
import { LIMITS, matchBrace, parseUi, type UiNode } from "./parse.ts";

const BIKE = `<script>
  const sections = [{ category: "Frame", name: "Main frame" }, { category: "Wheels", name: "Tires" }];
  let section = $state("All");
</script>
<box gap={3}>
  <row wrap gap={2}>
    {#each ["All", "Frame", "Wheels"] as s}
      <button variant={section === s ? "default" : "outline"} onClick={() => section = s}>{s}</button>
    {/each}
  </row>
  {#each sections.filter((x) => section === "All" || x.category === section) as part, i}
    <text><b>{part.name}</b> {part.category}</text>
    {#if i < 1}<divider/>{:else}<text tone="muted">last</text>{/if}
  {:else}
    <text>Nothing here</text>
  {/each}
  <slider min={1} max={7} value={3} stroke-width="2"/>
</box>`;

function tags(nodes: readonly UiNode[]): string[] {
  return nodes.flatMap((n) => {
    if (n.type === "element") return [n.tag, ...tags(n.children)];
    if (n.type === "each") return ["#each", ...tags(n.body), ...tags(n.fallback)];
    if (n.type === "if")
      return ["#if", ...n.branches.flatMap((b) => tags(b.body)), ...tags(n.fallback ?? [])];
    return [];
  });
}

describe("parseUi", () => {
  it("parses script, elements, blocks and expressions", () => {
    const program = parseUi(BIKE);
    expect(program.complete).toBe(true);
    expect(program.diagnostics).toEqual([]);
    expect(program.script?.code).toContain('$state("All")');
    expect(tags(program.nodes)).toEqual([
      "box",
      "row",
      "#each",
      "button",
      "#each",
      "text",
      "b",
      "#if",
      "divider",
      "text",
      "text",
      "slider",
    ]);
  });

  it("normalises event and kebab-case attribute names", () => {
    const program = parseUi(BIKE);
    const box = program.nodes.find((n) => n.type === "element")!;
    if (box.type !== "element") throw new Error("expected element");
    const slider = box.children.find((n) => n.type === "element" && n.tag === "slider");
    if (slider?.type !== "element") throw new Error("expected slider");
    expect(slider.attrs.map((a) => a.name)).toEqual(["min", "max", "value", "strokeWidth"]);
    expect(JSON.stringify(program)).toContain('"name":"onclick"');
  });

  it("never throws on any prefix of a block, and completes on the whole", () => {
    for (let n = 0; n <= BIKE.length; n++) {
      const program = parseUi(BIKE.slice(0, n));
      if (n < BIKE.length) expect(typeof program.complete).toBe("boolean");
    }
    expect(parseUi(BIKE).complete).toBe(true);
  });

  it("holds a half-written script back instead of parsing past it", () => {
    const program = parseUi("<script>\nlet x = $state(1");
    expect(program.script?.closed).toBe(false);
    expect(program.nodes).toEqual([]);
    expect(program.complete).toBe(false);
  });

  it("drops a trailing incomplete tag and auto-closes open elements", () => {
    const program = parseUi('<card><text>hello</text><button variant="out');
    expect(program.complete).toBe(false);
    expect(tags(program.nodes)).toEqual(["card", "text"]);
  });

  it("recovers from a mismatched closing tag with a diagnostic", () => {
    const program = parseUi("<card><row><text>x</text></card><text>after</text>");
    expect(tags(program.nodes)).toEqual(["card", "row", "text", "text"]);
    expect(program.diagnostics.map((d) => d.code)).toEqual(["unclosed_element"]);
  });

  it("ignores a script that is not at the top", () => {
    const program = parseUi("<text>a</text><script>let x = 1</script><text>b</text>");
    expect(program.script).toBeNull();
    expect(tags(program.nodes)).toEqual(["text", "text"]);
    expect(program.diagnostics.map((d) => d.code)).toEqual(["script_not_leading"]);
  });

  it("enforces the source, depth and node limits", () => {
    expect(parseUi("x".repeat(LIMITS.sourceChars + 1)).diagnostics.map((d) => d.code)).toEqual([
      "source_too_large",
    ]);
    const deep = "<box>".repeat(LIMITS.depth + 5);
    expect(parseUi(deep).diagnostics.some((d) => d.code === "too_deep")).toBe(true);
    const many = "<b/>".repeat(LIMITS.nodes + 10);
    const program = parseUi(many);
    expect(program.nodes).toHaveLength(LIMITS.nodes);
    expect(program.complete).toBe(false);
  });
});

describe("matchBrace", () => {
  it("skips braces in strings and template literals", () => {
    const code = '{ a: "}", b: `x${ {c: 1}.c }}` }} rest';
    expect(code.slice(0, matchBrace(code, 1))).toBe('{ a: "}", b: `x${ {c: 1}.c }}` }');
  });

  it("returns -1 when the expression is cut off", () => {
    expect(matchBrace("{ a: [1, 2", 1)).toBe(-1);
    expect(matchBrace('{ "unterminated', 1)).toBe(-1);
  });
});
