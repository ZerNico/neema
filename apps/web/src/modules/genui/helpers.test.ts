import variant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";
import { beforeAll, describe, expect, it } from "vitest";
import { compileUi } from "./compile.ts";
import { BlockRuntime } from "./runtime.ts";

let quickjs: QuickJSWASMModule;
beforeAll(async () => {
  quickjs = await newQuickJSWASMModuleFromVariant(variant);
});

/** One expression's value inside a real block, rendered with state that is frozen. */
function value(expression: string, script = ""): unknown {
  const compiled = compileUi(
    `<script>${script}</script><text>{JSON.stringify(${expression})}</text>`,
  );
  if (!compiled.ok) throw new Error(`compile failed: ${JSON.stringify(compiled.diagnostics)}`);
  const booted = BlockRuntime.boot(quickjs, compiled.block, null, 0);
  if (!booted.ok) throw new Error(booted.error);
  const out = booted.runtime.render();
  booted.runtime.dispose();
  if (!out.ok) throw new Error(out.error);
  const [node] = out.nodes as { children: string[] }[];
  return JSON.parse(node!.children.join(""));
}

describe("block helpers", () => {
  it("sums, averages and finds the median by key or function, skipping non-numbers", () => {
    const items = `const items = [{ p: 3 }, { p: 1 }, { p: "x" }, { p: 2 }];`;
    expect(value(`sum(items, "p")`, items)).toBe(6);
    expect(value(`mean(items, (i) => i.p * 2)`, items)).toBe(4);
    expect(value(`median([5, 1, 4, 2])`)).toBe(3);
    expect(value(`[mean([]), median([])].map(Number.isNaN)`)).toEqual([true, true]);
  });

  it("works on state while rendering, without sorting it in place", () => {
    const state = `let scores = $state([9, 3, 7]);`;
    expect(value(`[median(scores), scores]`, state)).toEqual([7, [9, 3, 7]]);
  });

  it("rounds half up and counts ranges either way", () => {
    expect(
      value(`[round(1.005, 2), round(2.5), round(-2.5), round(-1.005, 2), round("3.14", 1)]`),
    ).toEqual([1.01, 3, -3, -1.01, 3.1]);
    expect(value(`[range(3), range(1, 7, 2), range(3, 0)]`)).toEqual([
      [0, 1, 2],
      [1, 3, 5],
      [3, 2, 1],
    ]);
    expect(value(`range(0, 5, 0)`)).toEqual([]);
    // Ten steps of 0.1, not an eleventh at 0.9999999999999999.
    expect(value(`range(0, 1, 0.1).length`)).toBe(10);
  });

  it("bins values with the maximum in the last bin", () => {
    expect(value(`histogram([0, 1, 2, 3, 4], 2)`)).toEqual([
      { from: 0, to: 2, count: 2 },
      { from: 2, to: 4, count: 3 },
    ]);
    expect(value(`histogram([5, 50], 2, { min: 0, max: 10 }).map((b) => b.count)`)).toEqual([0, 1]);
    expect(value(`histogram([], 4)`)).toEqual([]);
    expect(value(`histogram([0.1, 0.9], 3, { min: 0, max: 0.9 }).at(-1).to`)).toBe(0.9);
    expect(value(`histogram([1], 2, { min: 5, max: 0 })`)).toEqual([]);
  });

  it("allocates shares that add up to the total exactly", () => {
    expect(value(`allocate(100, 3)`)).toEqual([33.34, 33.33, 33.33]);
    expect(value(`allocate(10, [1, 1, 1], 0)`)).toEqual([4, 3, 3]);
    expect(value(`sum(allocate(87.65, [2, 3, 5]))`)).toBe(87.65);
    expect(value(`allocate(5, 0)`)).toEqual([]);
    // One share per part in order: a gap gets nothing and shifts nobody.
    expect(value(`allocate(100, [1, null, 1])`)).toEqual([50, 0, 50]);
    expect(value(`allocate(10, [1, -0.5, 1])`)).toEqual([5, 0, 5]);
    expect(value(`allocate(1.005, 1)`)).toEqual([1.01]);
  });

  it("copies plain data with structuredClone", () => {
    expect(value(`structuredClone({ a: [1, { b: 2 }] })`)).toEqual({ a: [1, { b: 2 }] });
  });

  it("lets a block's own function of the same name win", () => {
    expect(value(`sum(1, 2)`, `function sum(a, b) { return a * b; }`)).toBe(2);
  });
});
