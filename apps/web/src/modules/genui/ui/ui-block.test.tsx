import variant from "@jitl/quickjs-wasmfile-release-sync";
import { act, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AssistantMarkdown } from "~/modules/chat/ui/assistant-markdown.tsx";
import { BlockEngine } from "../client/engine.ts";
import type { GenuiClient } from "../client/host.ts";
import { keyUiFences } from "../fences.ts";
import {
  GenuiActionsContext,
  GenuiClientContext,
  GenuiMessageContext,
  type GenuiActions,
} from "./context.ts";

// A block's first render loads the lazy renderer and runs QuickJS; under a
// full parallel run that outlasts the one-second default wait.
configure({ asyncUtilTimeout: 10_000 });

let quickjs: QuickJSWASMModule;
beforeAll(async () => {
  quickjs = await newQuickJSWASMModuleFromVariant(variant);
});

/** The Worker's engine, run in the test's own thread. */
function inProcess(engine: BlockEngine): GenuiClient {
  return {
    render: async (request) => engine.render(request),
    call: async (request) => engine.call(request),
    release: (block) => engine.release(block),
    epoch: () => 0,
    subscribe: () => () => {},
  };
}

const GEARS = [
  "Here are the gears:",
  "",
  "```ui",
  "<script>",
  "  const sprockets = [28, 24, 21, 18];",
  "  let gear = $state(2);",
  "  const ratio = $derived(42 / sprockets[gear - 1]);",
  "</script>",
  "<card>",
  "  <title>Gear {gear}</title>",
  '  <text tone="muted">Ratio <num value={ratio} format="decimal:2"/></text>',
  "  <button onclick={() => gear = Math.min(gear + 1, 4)}>Shift up</button>",
  "</card>",
  "```",
].join("\n");

function draw(markdown: string, messageId = "m1", streaming = false) {
  const engine = new BlockEngine(quickjs);
  return render(
    <GenuiClientContext value={inProcess(engine)}>
      <GenuiMessageContext value={{ messageId, createdAt: 0, streaming }}>
        <AssistantMarkdown content={keyUiFences(markdown, 0)} streaming={streaming} />
      </GenuiMessageContext>
    </GenuiClientContext>,
  );
}

describe("ui blocks in answers", () => {
  it("draws the block with app components and runs its handlers", async () => {
    draw(GEARS);
    expect(await screen.findByText("Gear 2")).toBeInTheDocument();
    expect(screen.getByText(/Ratio/)).toHaveTextContent(/Ratio\s?1[.,]75/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Shift up" }));
    });
    expect(await screen.findByText("Gear 3")).toBeInTheDocument();
    expect(screen.getByText(/Ratio/)).toHaveTextContent(/Ratio\s?2[.,]00/);
  });

  it("shows the source when the script breaks the contract", async () => {
    draw("```ui\n<script>let x = 0; function f() { x++; }</script>\n<text>never</text>\n```");
    await waitFor(() =>
      expect(document.querySelector("pre code")).toHaveTextContent("function f()"),
    );
    expect(screen.queryByText("never")).not.toBeInTheDocument();
  });

  it("renders an unkeyed fence as code", async () => {
    const engine = new BlockEngine(quickjs);
    render(
      <GenuiClientContext value={inProcess(engine)}>
        <GenuiMessageContext value={{ messageId: "m1", createdAt: 0, streaming: false }}>
          <AssistantMarkdown content={"```ui\n<text>hello</text>\n```"} streaming={false} />
        </GenuiMessageContext>
      </GenuiClientContext>,
    );
    await waitFor(() =>
      expect(document.querySelector("pre code")).toHaveTextContent("<text>hello</text>"),
    );
  });

  it("draws tables, progress, charts and drawings", async () => {
    draw(
      [
        "```ui",
        '<table columns={["Gear", "Teeth"]} rows={[[1, 28], [2, 24]]}/>',
        '<progress value={40} label="Climb"/>',
        '<chart type="bar" label="Teeth per gear" x={[1, 2]} series={[{ name: "Teeth", values: [28, 24] }]}/>',
        '<svg viewBox="0 0 100 40" label="Sprockets">',
        '  {#each [28, 24] as t, i}<circle cx={20 + i * 40} cy="20" r={t / 2} fill={i === 0 ? "chart-1" : "none"} stroke="currentColor"/>{/each}',
        '  <text x="50" y="38" textAnchor="middle">gears</text>',
        "</svg>",
        "```",
      ].join("\n"),
    );
    expect(await screen.findByRole("columnheader", { name: "Teeth" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "28" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Climb" })).toBeInTheDocument();
    const drawing = screen.getByRole("img", { name: "Sprockets" });
    const circles = drawing.querySelectorAll("circle");
    expect(circles).toHaveLength(2);
    expect(circles[0]).toHaveAttribute("fill", "var(--chart-1)");
    expect(circles[1]).toHaveAttribute("fill", "none");
    expect(drawing.querySelector("text")).toHaveTextContent("gears");
  });
});

describe("what blocks may do", () => {
  const BLOCK = [
    "```ui",
    "<script>let n = $state(0);</script>",
    "<text>Count {n}</text>",
    "<button onclick={() => { n++; send('Explain step ' + n); }}>Step</button>",
    '<button onclick={() => send("Look at\\u200bhidden")}>Sneaky</button>',
    "<suggestions>",
    "  <suggestion>Compare with a 21-speed bike</suggestion>",
    "  <suggestion>Read https://example.com/guide</suggestion>",
    "</suggestions>",
    "```",
  ].join("\n");

  function drawWith(actions: Partial<GenuiActions>, tailId = "m1") {
    const all: GenuiActions = {
      tailId,
      disabled: false,
      send: vi.fn(),
      offer: vi.fn(),
      save: vi.fn(),
      ...actions,
    };
    const engine = new BlockEngine(quickjs);
    render(
      <GenuiClientContext value={inProcess(engine)}>
        <GenuiActionsContext value={all}>
          <GenuiMessageContext
            value={{ messageId: "m1", createdAt: 0, streaming: false, generationId: "g1" }}
          >
            <AssistantMarkdown content={keyUiFences(BLOCK, 0)} streaming={false} />
          </GenuiMessageContext>
        </GenuiActionsContext>
      </GenuiClientContext>,
    );
    return all;
  }

  it("sends a plain suggestion as is, and offers one with a link to the composer", async () => {
    const actions = drawWith({});
    fireEvent.click(await screen.findByRole("button", { name: "Compare with a 21-speed bike" }));
    expect(actions.send).toHaveBeenCalledWith("Compare with a 21-speed bike");
    fireEvent.click(screen.getByRole("button", { name: "Read https://example.com/guide" }));
    expect(actions.offer).toHaveBeenCalledWith("Read https://example.com/guide");
    expect(actions.send).toHaveBeenCalledTimes(1);
  });

  it("puts a handler's message in the composer and saves the new state", async () => {
    const actions = drawWith({});
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Step" }));
    });
    expect(await screen.findByText("Count 1")).toBeInTheDocument();
    expect(actions.offer).toHaveBeenCalledWith("Explain step 1");
    expect(actions.send).not.toHaveBeenCalled();
    // Saves wait for the reader to settle.
    await waitFor(() => expect(actions.save).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(actions.save).toHaveBeenCalledWith({
      messageId: "m1",
      generationId: "g1",
      ordinal: 0,
      sourceHash: expect.stringMatching(/^[0-9a-f]{16}$/),
      state: '{"n":1,"__seed":0}',
    });
  });

  it("drops a message with invisible characters", async () => {
    const actions = drawWith({});
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Sneaky" }));
    });
    expect(actions.offer).not.toHaveBeenCalled();
    expect(actions.send).not.toHaveBeenCalled();
  });

  it("keeps suggestions disabled on an answer that is not the last message", async () => {
    drawWith({}, "m2");
    expect(
      await screen.findByRole("button", { name: "Compare with a 21-speed bike" }),
    ).toBeDisabled();
  });
});
