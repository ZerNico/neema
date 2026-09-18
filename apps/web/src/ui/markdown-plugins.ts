import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import type { ComponentProps } from "react";
import type { DiagramPlugin, Streamdown } from "streamdown";

type PluginConfig = NonNullable<ComponentProps<typeof Streamdown>["plugins"]>;
type MermaidInstance = ReturnType<DiagramPlugin["getMermaid"]>;
type MermaidConfig = Parameters<MermaidInstance["initialize"]>[0];

// mermaid is ~950 KB gzipped and imported at module scope by
// @streamdown/mermaid, so re-exporting it here would drag all of it into the
// chat bundle. Streamdown only calls getMermaid() then awaits render(), so
// this stand-in fetches the real plugin on first diagram; conversations
// without one never pay.
let pending: Promise<DiagramPlugin> | null = null;
const loadMermaid = (): Promise<DiagramPlugin> =>
  (pending ??= import("@streamdown/mermaid").then((m) => m.mermaid));

let config: MermaidConfig | undefined;
let applied = false;

const lazyMermaid: MermaidInstance = {
  initialize(next) {
    config = { ...config, ...next };
    applied = false;
  },
  async render(id, source) {
    const plugin = await loadMermaid();
    // Handing over a config re-runs mermaid.initialize, so only do that on the
    // first render and again whenever the config actually changed.
    const instance = plugin.getMermaid(applied ? undefined : config);
    applied = true;
    return instance.render(id, source);
  },
};

/**
 * Streamdown's plugins are opt-in; without them fences render as text,
 * `$$…$$` stays literal, and CJK autolinks eat trailing punctuation. One
 * shared config so shiki initializes once, not per message. `math` keeps
 * `singleDollarTextMath: false`, since "$5 and $10" would otherwise misparse
 * as math; `$$…$$` works inline and as block.
 */
export const markdownPlugins: PluginConfig = {
  cjk,
  code,
  math,
  mermaid: {
    name: "mermaid",
    type: "diagram",
    language: "mermaid",
    getMermaid(next) {
      if (next) lazyMermaid.initialize(next);
      return lazyMermaid;
    },
  },
};
