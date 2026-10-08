import variant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";
import { beforeAll, describe, expect, it } from "vitest";
import { compileUi } from "./compile.ts";
import { BlockRuntime } from "./runtime.ts";

let quickjs: QuickJSWASMModule;
beforeAll(async () => {
  quickjs = await newQuickJSWASMModuleFromVariant(variant);
});

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

function boot(source: string, saved: string | null = null): BlockRuntime {
  const result = compileUi(source);
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`);
  const booted = BlockRuntime.boot(quickjs, result.block, saved, NOW);
  if (!booted.ok) throw new Error(`boot failed: ${booted.error}`);
  return booted.runtime;
}

interface TreeNode {
  tag: string;
  props: Record<string, unknown>;
  children: (TreeNode | string)[];
}

function render(rt: BlockRuntime): { rev: number; nodes: (TreeNode | string)[] } {
  const out = rt.render();
  if (!out.ok) throw new Error(`render failed: ${out.error}`);
  return { rev: out.rev, nodes: out.nodes as (TreeNode | string)[] };
}

function text(nodes: readonly (TreeNode | string)[]): string {
  return nodes.map((n) => (typeof n === "string" ? n : text(n.children))).join("");
}

function handlerOf(node: TreeNode, prop: string): { $h: number; rev: number } {
  const ref = node.props[prop];
  if (typeof ref !== "object" || ref === null || !("$h" in ref) || !("rev" in ref))
    throw new Error("no handler");
  return { $h: Number(ref.$h), rev: Number(ref.rev) };
}

const GEARS = `<script>
  const sprockets = [28, 24, 21, 18, 16, 14, 12];
  let gear = $state(4);
  const ratio = $derived(42 / sprockets[gear - 1]);
</script>
<card>
  <title>Gear {gear}: {ratio.toFixed(2)}</title>
  <button onclick={() => gear = gear + 1}>Up</button>
  {#each sprockets as t, i}{#if i + 1 === gear}<b>{t}T</b>{/if}{/each}
</card>`;

describe("BlockRuntime", () => {
  it("renders, runs a handler and re-renders with the new state", () => {
    const rt = boot(GEARS);
    const first = render(rt);
    expect(text(first.nodes)).toContain("Gear 4: 2.33");
    expect(text(first.nodes)).toContain("18T");
    const card = first.nodes.find((n): n is TreeNode => typeof n !== "string")!;
    const button = card.children.find(
      (n): n is TreeNode => typeof n !== "string" && n.tag === "button",
    )!;
    const ref = handlerOf(button, "onclick");
    expect(rt.call(ref.rev, ref.$h, [])).toEqual({ ok: true, actions: [], error: null });
    const second = render(rt);
    expect(text(second.nodes)).toContain("Gear 5: 2.63");
    expect(rt.state()).toBe(JSON.stringify({ gear: 5, __seed: NOW >>> 0 }));
    rt.dispose();
  });

  it("refuses a handler from an older render", () => {
    const rt = boot(GEARS);
    const first = render(rt);
    const card = first.nodes.find((n): n is TreeNode => typeof n !== "string")!;
    const button = card.children.find(
      (n): n is TreeNode => typeof n !== "string" && n.tag === "button",
    )!;
    const ref = handlerOf(button, "onclick");
    render(rt);
    expect(rt.call(ref.rev, ref.$h, [])).toEqual({ ok: false, stale: true });
    rt.dispose();
  });

  it("restores saved state and rebuilds an identical tree", () => {
    const live = boot(GEARS);
    const card = render(live).nodes.find((n): n is TreeNode => typeof n !== "string")!;
    const ref = handlerOf(
      card.children.find((n): n is TreeNode => typeof n !== "string" && n.tag === "button")!,
      "onclick",
    );
    live.call(ref.rev, ref.$h, []);
    const liveTree = render(live).nodes;
    const saved = live.state();
    const rebuilt = boot(GEARS, saved);
    // Handler references carry the render revision, which counts renders.
    const withoutRev = (nodes: unknown) =>
      JSON.stringify(nodes, (k, v: unknown) => (k === "rev" ? undefined : v));
    expect(withoutRev(render(rebuilt).nodes)).toBe(withoutRev(liveTree));
    live.dispose();
    rebuilt.dispose();
  });

  it("stops runaway scripts, renders and handlers at their limits", () => {
    expect(
      BlockRuntime.boot(
        quickjs,
        compiled("<script>while (true) {}</script><text>x</text>"),
        null,
        NOW,
      ),
    ).toMatchObject({
      ok: false,
      error: "interrupted",
    });
    const recursion = boot(
      "<script>function f(n) { return f(n + 1) + 1; }</script><text>{f(0)}</text>",
    );
    // The overflow is caught per expression: the node blanks, the block lives.
    expect(text(render(recursion).nodes)).toBe("");
    recursion.dispose();
    const loop = boot("<text>{(() => { while (true) {} })()}</text>");
    expect(loop.render()).toEqual({ ok: false, error: "interrupted" });
    loop.dispose();
    const bomb = boot(
      "<script>let n = $state(0);</script><button onclick={() => { const a = []; while (true) a.push('x'.repeat(1e5)); }}>go</button>",
    );
    const button = render(bomb).nodes.find((n): n is TreeNode => typeof n !== "string")!;
    const ref = handlerOf(button, "onclick");
    expect(bomb.call(ref.rev, ref.$h, [])).toMatchObject({ ok: false, stale: false });
    // The runtime survives and still renders.
    expect(bomb.render().ok).toBe(true);
    bomb.dispose();
  });

  it("makes state read-only while rendering", () => {
    const rt = boot("<script>let n = $state(1);</script><text>{n = 5}</text><text>{n}</text>");
    expect(text(render(rt).nodes)).toBe("1");
    expect(rt.state()).toBe(JSON.stringify({ n: 1, __seed: NOW >>> 0 }));
    rt.dispose();
  });

  it("freezes constants so a helper cannot keep hidden state", () => {
    const rt = boot(
      "<script>const items = [1, 2];\nlet total = $state(0);\nfunction add() { items.push(3); total = items.length; }</script><button onclick={add}>add</button><text>{total}</text>",
    );
    const button = render(rt).nodes.find((n): n is TreeNode => typeof n !== "string")!;
    const ref = handlerOf(button, "onclick");
    const out = rt.call(ref.rev, ref.$h, []);
    expect(out).toMatchObject({ ok: true });
    expect(out.ok && out.error).toBeTruthy();
    expect(text(render(rt).nodes)).toBe("add0");
    rt.dispose();
  });

  it("freezes the clock and keeps randomness out of rendering", () => {
    const rt = boot(
      "<script>let roll = $state(0);</script><text>{new Date().getTime()}|{Date.now()}|{now}</text><text>{random()}</text><button onclick={() => roll = Math.floor(random() * 6) + 1}>roll</button><text>{roll}</text>",
    );
    const first = render(rt).nodes;
    expect(text(first)).toBe(`${NOW}|${NOW}|${NOW}roll0`);
    const button = first.find((n): n is TreeNode => typeof n !== "string" && n.tag === "button")!;
    const ref = handlerOf(button, "onclick");
    rt.call(ref.rev, ref.$h, []);
    const rolled = text(render(rt).nodes);
    // Same seed, same roll: replaying from saved state gives the same result.
    const replay = boot(
      "<script>let roll = $state(0);</script><text>{new Date().getTime()}|{Date.now()}|{now}</text><text>{random()}</text><button onclick={() => roll = Math.floor(random() * 6) + 1}>roll</button><text>{roll}</text>",
    );
    const replayButton = render(replay).nodes.find(
      (n): n is TreeNode => typeof n !== "string" && n.tag === "button",
    )!;
    const replayRef = handlerOf(replayButton, "onclick");
    replay.call(replayRef.rev, replayRef.$h, []);
    expect(text(render(replay).nodes)).toBe(rolled);
    expect(rolled).toMatch(/roll[1-6]$/);
    rt.dispose();
    replay.dispose();
  });

  it("only queues actions from handlers, one per call", () => {
    const rt = boot(
      '<text>{send("from render")}</text><button onclick={() => { send("first"); open("https://a.dev"); }}>go</button>',
    );
    const nodes = render(rt).nodes;
    expect(text(nodes)).toBe("go");
    const button = nodes.find((n): n is TreeNode => typeof n !== "string" && n.tag === "button")!;
    const ref = handlerOf(button, "onclick");
    expect(rt.call(ref.rev, ref.$h, [])).toEqual({
      ok: true,
      actions: [{ kind: "send", value: "first" }],
      error: null,
    });
    rt.dispose();
  });

  it("passes handler arguments as JSON", () => {
    const rt = boot(
      "<script>let v = $state(1);</script><slider min={0} max={10} value={v} onchange={(x) => v = x}/><text>{v}</text>",
    );
    const slider = render(rt).nodes.find((n): n is TreeNode => typeof n !== "string")!;
    const ref = handlerOf(slider, "onchange");
    rt.call(ref.rev, ref.$h, [7]);
    expect(text(render(rt).nodes)).toBe("7");
    rt.dispose();
  });

  it("never lets a function or host value cross the boundary", () => {
    const rt = boot(
      "<script>const f = () => 1;</script><text>{f}</text><card title={{ toString: f }}/><text>{[f, Symbol('x')]}</text>",
    );
    const out = rt.render();
    expect(out).toMatchObject({ ok: true });
    expect(JSON.stringify(out)).not.toContain("=>");
    rt.dispose();
  });

  it("restores only declared state from a saved snapshot", () => {
    const rt = boot(
      "<script>let gear = $state(4);</script><text>{gear}|{typeof send}|{String(typeof toString === 'number')}</text>",
      JSON.stringify({ gear: 6, send: "hijack", toString: 1, __seed: 9 }),
    );
    expect(text(render(rt).nodes)).toBe("6|function|false");
    expect(rt.state()).toBe(JSON.stringify({ gear: 6, __seed: 9 }));
    rt.dispose();
  });

  it("refuses a script that breaks the mutation contract instead of running it", () => {
    const result = compileUi(
      "<script>let hidden = 0;\nfunction bump() { hidden++; }</script><text>x</text>",
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.diagnostics.map((d) => d.code)).toEqual(["assigns_non_state"]);
  });
});

function compiled(source: string) {
  const result = compileUi(source);
  if (!result.ok) throw new Error("compile failed");
  return result.block;
}
