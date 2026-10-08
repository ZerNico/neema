import variant from "@jitl/quickjs-wasmfile-release-sync";
import { act, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AssistantMarkdown } from "~/modules/chat/ui/assistant-markdown.tsx";
import { BlockEngine } from "../client/engine.ts";
import type { GenuiClient } from "../client/host.ts";
import { hashSource, keyUiFences, scanUiFences } from "../fences.ts";
import {
  GenuiActionsContext,
  GenuiClientContext,
  GenuiMessageContext,
  type GenuiActions,
  type GenuiMessage,
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

function draw(
  markdown: string,
  messageId = "m1",
  streaming = false,
  images: GenuiMessage["images"] = {},
) {
  const engine = new BlockEngine(quickjs);
  return render(
    <GenuiClientContext value={inProcess(engine)}>
      <GenuiMessageContext value={{ messageId, createdAt: 0, streaming, images }}>
        <AssistantMarkdown content={keyUiFences(markdown, 0)} streaming={streaming} />
      </GenuiMessageContext>
    </GenuiClientContext>,
  );
}

describe("ui blocks in answers", () => {
  it("gives a slider one thumb, so a press on its track moves it", async () => {
    const { container } = draw(
      [
        "```ui",
        "<script>let n = $state(3);</script>",
        '<slider label="Amount" min={0} max={10} value={n} onchange={(v) => n = v}/>',
        "```",
      ].join("\n"),
      "m-slider",
    );
    await screen.findByText("Amount");
    // A second thumb without a value took every track press for itself.
    expect(container.querySelectorAll('input[type="range"]')).toHaveLength(1);
  });

  it("shows the images the server found, and says why when there are none", async () => {
    draw(
      [
        "```ui",
        '<image query="gear  hub" caption="A hub"/>',
        '<images query={["cassette", "chain"]}/>',
        "```",
      ].join("\n"),
      "m-img",
      false,
      {
        "gear hub": {
          status: "resolved",
          items: [
            {
              attachmentId: "a1",
              pageUrl: "https://www.bikes.example/hub",
              title: "Hub",
              size: 2048,
            },
          ],
        },
        cassette: { status: "search_off", items: [] },
      },
    );
    const hub = await screen.findByRole("img", { name: "A hub" });
    expect(hub).toHaveAttribute("src", "/api/files/a1");
    expect(screen.getByRole("link", { name: "bikes.example" })).toBeInTheDocument();
    // A found image opens in the same preview as any attached one.
    fireEvent.click(screen.getByRole("button", { name: "Preview A hub" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("img")).toHaveAttribute("src", "/api/files/a1");
    expect(within(dialog).getByText("2 KB")).toBeInTheDocument();
    expect(screen.getByText("Images need web search")).toBeInTheDocument();
    // Never resolved, and the answer is finished.
    expect(screen.getByText("Image unavailable")).toBeInTheDocument();
  });

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

  function drawWith(
    actions: Partial<GenuiActions>,
    tailId = "m1",
    markdown = BLOCK,
    messageId = "m1",
  ) {
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
            value={{ messageId, createdAt: 0, streaming: false, generationId: "g1" }}
          >
            <AssistantMarkdown content={keyUiFences(markdown, 0)} streaming={false} />
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
      // The hash the server computes from the stored message, or every save is refused.
      sourceHash: hashSource(scanUiFences(BLOCK)[0]!.code),
      state: '{"n":1,"__seed":0}',
    });
  });

  it("lets a drawing's parts change state, by pointer or keyboard, but never send", async () => {
    const actions = drawWith(
      {},
      "m-shape",
      [
        "```ui",
        "<script>let n = $state(0);</script>",
        "<text>Taps {n}</text>",
        '<svg viewBox="0 0 10 10" label="Pad">',
        "  <rect width={10} height={10} label=\"Tap pad\" onclick={() => { n++; send('From a shape'); }}/>",
        "</svg>",
        "```",
      ].join("\n"),
      "m-shape",
    );
    const pad = await screen.findByRole("button", { name: "Tap pad" });
    await act(async () => {
      fireEvent.click(pad);
    });
    expect(await screen.findByText("Taps 1")).toBeInTheDocument();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("button", { name: "Tap pad" }), { key: "Enter" });
    });
    expect(await screen.findByText("Taps 2")).toBeInTheDocument();
    // Its text was never shown to the reader as a label, so a shape cannot send it.
    expect(actions.offer).not.toHaveBeenCalled();
    expect(actions.send).not.toHaveBeenCalled();
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
