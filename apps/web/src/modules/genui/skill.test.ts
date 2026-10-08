import variant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";
import { beforeAll, describe, expect, it } from "vitest";
import type { ValidNode } from "./catalog.ts";
import { BlockEngine } from "./client/engine.ts";
import { extractImageQueries } from "./extract.ts";
import { scanUiFences } from "./fences.ts";
import { INTERACTIVE_UI_SKILL_ROOT, SKILL_EXAMPLES } from "./skill.ts";

let quickjs: QuickJSWASMModule;
beforeAll(async () => {
  quickjs = await newQuickJSWASMModuleFromVariant(variant);
});

const tags = (nodes: readonly (ValidNode | string)[]): string[] =>
  nodes.flatMap((node) => (typeof node === "string" ? [] : [node.tag, ...tags(node.children)]));

const handlers = (nodes: readonly (ValidNode | string)[]): Array<{ $h: number; rev: number }> =>
  nodes.flatMap((node) => {
    if (typeof node === "string") return [];
    const own = Object.values(node.props).filter(
      (value): value is { $h: number; rev: number } =>
        typeof value === "object" && value !== null && "$h" in value,
    );
    return [...own, ...handlers(node.children)];
  });

describe("the interactive-ui skill", () => {
  it.each(Object.entries(SKILL_EXAMPLES))(
    "renders its %s example cleanly and runs every handler",
    (name, code) => {
      const engine = new BlockEngine(quickjs);
      const reply = engine.render({ block: `skill:${name}`, code, saved: null, now: 0 });
      if (!reply.ok) throw new Error(`${reply.reason}: ${reply.error ?? ""}`);
      // A model copies examples closely: a dropped prop here would teach it a mistake.
      expect(reply.diagnostics).toEqual([]);
      expect(tags(reply.nodes).length).toBeGreaterThan(3);
      for (const ref of handlers(reply.nodes)) {
        const called = engine.call({
          block: `skill:${name}`,
          source: reply.source,
          handler: ref.$h,
          rev: reply.rev,
          args: [2],
        });
        // Only a handler from an older render may be refused; none may fail.
        if (!called.ok) expect(called).toMatchObject({ stale: true });
        else expect(called.render.ok).toBe(true);
      }
    },
  );

  it("embeds every example as a closed block, with literal image queries", () => {
    const fences = scanUiFences(INTERACTIVE_UI_SKILL_ROOT);
    expect(fences.map((fence) => fence.code)).toEqual(Object.values(SKILL_EXAMPLES));
    expect(fences.every((fence) => fence.closed)).toBe(true);
    expect(extractImageQueries(INTERACTIVE_UI_SKILL_ROOT)).toEqual([
      "lithium ion battery cell cutaway",
      "battery health screen iphone",
    ]);
  });

  it("stays small enough to load beside a long conversation", () => {
    expect(INTERACTIVE_UI_SKILL_ROOT.length).toBeLessThan(16_000);
  });
});
