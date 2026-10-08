import variant from "@jitl/quickjs-wasmfile-release-sync";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";
import { beforeAll, describe, expect, it } from "vitest";
import { AssistantMarkdown } from "~/modules/chat/ui/assistant-markdown.tsx";
import { BlockEngine } from "../client/engine.ts";
import type { GenuiClient } from "../client/host.ts";
import { keyUiFences } from "../fences.ts";
import { GenuiClientContext, GenuiMessageContext } from "./context.ts";

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
