import { describe, expect, it } from "vitest";
import { catalogReference, TREE_LIMITS, validateTree, type ValidNode } from "./catalog.ts";

const el = (tag: string, props: Record<string, unknown> = {}, children: unknown[] = []) => ({
  tag,
  props,
  children,
});

function only(nodes: readonly (ValidNode | string)[]): ValidNode {
  const [node] = nodes;
  if (!node || typeof node === "string") throw new Error("expected one node");
  return node;
}

describe("validateTree", () => {
  it("keeps known tags and props of the declared types", () => {
    const { nodes, diagnostics } = validateTree([
      el("card", { title: "Gears" }, [
        el("slider", { min: 1, max: 7, value: 4, onchange: { $h: 0, rev: 1 } }),
      ]),
    ]);
    expect(diagnostics).toEqual([]);
    expect(only(nodes)).toEqual({
      tag: "card",
      props: { title: "Gears" },
      children: [
        {
          tag: "slider",
          props: { min: 1, max: 7, value: 4, onchange: { $h: 0, rev: 1 } },
          children: [],
        },
      ],
    });
  });

  it("drops unknown tags, unknown props and invalid values", () => {
    const { nodes, diagnostics } = validateTree([
      el("text", { tone: "neon", class: "x", size: "sm" }, ["hi"]),
      el("iframe", { src: "https://evil.example" }),
    ]);
    expect(only(nodes)).toEqual({ tag: "text", props: { size: "sm" }, children: ["hi"] });
    expect(diagnostics.map((d) => `${d.code}:${d.detail}`)).toEqual([
      "invalid_prop:text.tone",
      "unknown_prop:text.class",
      "unknown_tag:iframe",
    ]);
  });

  it("treats tags named after prototype members as unknown", () => {
    const { nodes, diagnostics } = validateTree([
      el("constructor"),
      el("__proto__"),
      el("toString"),
      el("text", {}, ["hi"]),
    ]);
    expect(only(nodes).tag).toBe("text");
    expect(diagnostics.map((d) => d.code)).toEqual(["unknown_tag", "unknown_tag", "unknown_tag"]);
  });

  it("omits a node missing a required prop and nodes in the wrong place", () => {
    const { nodes, diagnostics } = validateTree([
      el("slider", { min: 1, max: 2 }),
      el("tabs", {}, [el("text", {}, ["not a tab"]), el("tab", { label: "A" }, ["ok"])]),
      el("b", {}, [el("card")]),
    ]);
    expect(nodes).toEqual([
      {
        tag: "tabs",
        props: {},
        children: [{ tag: "tab", props: { label: "A" }, children: ["ok"] }],
      },
      { tag: "b", props: {}, children: [] },
    ]);
    expect(diagnostics.map((d) => d.code)).toEqual([
      "missing_prop",
      "not_allowed_here",
      "not_allowed_here",
    ]);
  });

  it("only accepts http(s) links", () => {
    expect(validateTree([el("link", { href: "javascript:alert(1)" }, ["x"])]).nodes).toEqual([]);
    expect(only(validateTree([el("link", { href: "https://a.dev" }, ["x"])]).nodes).props).toEqual({
      href: "https://a.dev",
    });
  });

  it("enforces the node cap", () => {
    const many = Array.from({ length: TREE_LIMITS.nodes + 5 }, () => el("divider"));
    const { nodes, diagnostics } = validateTree(many);
    expect(nodes).toHaveLength(TREE_LIMITS.nodes);
    expect(diagnostics.at(-1)?.code).toBe("tree_too_large");
  });
});

describe("validateTree on drawings", () => {
  const drawing = (children: unknown[]) =>
    el("svg", { viewBox: "0 0 100 100", label: "Gears" }, children);

  it("keeps geometry and theme colours, and reads <text> as SVG text", () => {
    const svg = only(
      validateTree([
        drawing([
          el("g", { transform: "translate(10, 5) rotate(45)" }, [
            el("circle", { cx: 50, cy: 50, r: 10, fill: "chart-1", strokeWidth: 2 }),
            el("text", { x: 50, y: 90, textAnchor: "middle" }, ["1"]),
          ]),
        ]),
      ]).nodes,
    );
    expect(svg.children).toEqual([
      {
        tag: "g",
        props: { transform: "translate(10, 5) rotate(45)" },
        children: [
          {
            tag: "circle",
            props: { cx: 50, cy: 50, r: 10, fill: "chart-1", strokeWidth: 2 },
            children: [],
          },
          { tag: "text", props: { x: 50, y: 90, textAnchor: "middle" }, children: ["1"] },
        ],
      },
    ]);
  });

  // Known SVG injection shapes: each must be dropped, never passed through.
  const payloads: [string, unknown][] = [
    ["script element", el("script", {}, ["alert(1)"])],
    ["foreignObject", el("foreignObject", {}, [el("div", {}, ["<img src=x onerror=alert(1)>"])])],
    ["use with href", el("use", { href: "#x" })],
    ["image with href", el("image", { href: "https://evil.example/x.png" })],
    ["animate", el("animate", { attributeName: "href", to: "javascript:alert(1)" })],
    [
      "a with href",
      el("a", { href: "javascript:alert(1)" }, [el("rect", { width: 1, height: 1 })]),
    ],
    ["event attribute", el("rect", { width: 1, height: 1, onload: "alert(1)" })],
    [
      "style attribute",
      el("rect", { width: 1, height: 1, style: "fill:url(https://evil.example)" }),
    ],
    ["url() paint", el("rect", { width: 1, height: 1, fill: "url(#grad)" })],
    ["raw hex colour", el("rect", { width: 1, height: 1, fill: "#ff0000" })],
    ["filter", el("filter", { id: "f" })],
    ["non-finite number", el("circle", { r: Number.POSITIVE_INFINITY })],
    ["transform injection", el("g", { transform: "matrix(1,0,0,1,0,0) url(x)" })],
    ["path with letters", el("path", { d: "M0 0 javascript:alert(1)" })],
    ["oversized path", el("path", { d: "M0 0 ".repeat(TREE_LIMITS.pathChars) })],
  ];

  for (const [name, payload] of payloads) {
    it(`fails closed on ${name}`, () => {
      const svg = only(validateTree([drawing([payload])]).nodes);
      const serialized = JSON.stringify(svg);
      expect(serialized).not.toMatch(
        /javascript:|onload|onerror|url\(|#ff0000|script|foreignObject|href|style|matrix/,
      );
    });
  }

  it("keeps drawings out of text and text out of drawings", () => {
    expect(validateTree([el("text", {}, [drawing([])])]).nodes).toEqual([
      { tag: "text", props: {}, children: [] },
    ]);
    expect(only(validateTree([drawing(["loose text", el("button")])]).nodes).children).toEqual([]);
  });

  it("caps drawing size", () => {
    const shapes = Array.from({ length: TREE_LIMITS.svgNodes + 5 }, () => el("circle", { r: 1 }));
    const svg = only(validateTree([drawing(shapes)]).nodes);
    expect(svg.children.length).toBeLessThan(TREE_LIMITS.svgNodes);
  });
});

describe("catalogReference", () => {
  it("lists every group with typed signatures", () => {
    const reference = catalogReference();
    expect(reference).toContain("### Layout");
    expect(reference).toContain("### Drawing (inside <svg> only)");
    expect(reference).toContain(
      "<slider min: number, max: number, step?: number, value: number, onchange?: handler, label?: string>",
    );
    expect(reference).toBe(catalogReference());
  });
});
