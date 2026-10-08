import variant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";
import { beforeAll, describe, expect, it } from "vitest";
import type { ValidNode } from "../catalog.ts";
import { BlockEngine, MAX_LIVE_BLOCKS, type RenderReply } from "./engine.ts";

let quickjs: QuickJSWASMModule;
beforeAll(async () => {
  quickjs = await newQuickJSWASMModuleFromVariant(variant);
});

const COUNTER = `<script>let n = $state(0);</script><button onclick={() => n++}>Add</button><text>{n}</text>`;

function ok(reply: RenderReply): Extract<RenderReply, { ok: true }> {
  if (!reply.ok) throw new Error(`render failed: ${reply.reason} ${reply.error ?? ""}`);
  return reply;
}

const button = (reply: Extract<RenderReply, { ok: true }>) =>
  reply.nodes.find((n): n is ValidNode => typeof n !== "string" && n.tag === "button")!;

function refOf(node: ValidNode) {
  const ref = node.props.onclick;
  if (typeof ref !== "object" || ref === null || !("$h" in ref) || !("rev" in ref)) {
    throw new Error("no handler");
  }
  return { handler: Number(ref.$h), rev: Number(ref.rev) };
}

describe("BlockEngine", () => {
  it("renders a validated tree and applies a handler", () => {
    const engine = new BlockEngine(quickjs);
    const first = ok(engine.render({ block: "m:0", code: COUNTER, saved: null, now: 0 }));
    const reply = engine.call({ block: "m:0", ...refOf(button(first)), args: [] });
    expect(reply.ok && reply.render.ok && JSON.stringify(reply.render.nodes)).toContain('"1"');
    expect(reply.ok && reply.render.ok && reply.render.state).toBe('{"n":1,"__seed":0}');
  });

  it("drops a tag named after a prototype member instead of failing the block", () => {
    const engine = new BlockEngine(quickjs);
    const reply = ok(
      engine.render({ block: "m:0", code: "<constructor/><text>hi</text>", saved: null, now: 0 }),
    );
    expect(JSON.stringify(reply.nodes)).toContain("hi");
  });

  it("keeps state while the source grows and waits for an unfinished script", () => {
    const engine = new BlockEngine(quickjs);
    expect(
      engine.render({ block: "m:0", code: "<script>let n = $st", saved: null, now: 0 }),
    ).toMatchObject({
      ok: false,
      reason: "incomplete",
    });
    const first = ok(engine.render({ block: "m:0", code: COUNTER, saved: null, now: 0 }));
    engine.call({ block: "m:0", ...refOf(button(first)), args: [] });
    const grown = ok(
      engine.render({ block: "m:0", code: `${COUNTER}<divider/>`, saved: null, now: 0 }),
    );
    expect(grown.state).toBe('{"n":1,"__seed":0}');
  });

  it("reports a script that breaks the contract as rejected", () => {
    const engine = new BlockEngine(quickjs);
    expect(
      engine.render({
        block: "m:0",
        code: "<script>let x = 0; function f() { x++ }</script>",
        saved: null,
        now: 0,
      }),
    ).toMatchObject({ ok: false, reason: "rejected" });
  });

  it("evicts the least recently used block and treats its handlers as stale", () => {
    const engine = new BlockEngine(quickjs);
    const first = ok(engine.render({ block: "b:0", code: COUNTER, saved: null, now: 0 }));
    for (let i = 1; i <= MAX_LIVE_BLOCKS; i++)
      engine.render({ block: `b:${i}`, code: COUNTER, saved: null, now: 0 });
    expect(engine.call({ block: "b:0", ...refOf(button(first)), args: [] })).toEqual({
      ok: false,
      stale: true,
    });
  });
});
