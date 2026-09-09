import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import type { ComponentProps } from "react";
import type { DiagramPlugin, Streamdown } from "streamdown";

type PluginConfig = NonNullable<ComponentProps<typeof Streamdown>["plugins"]>;
type MermaidInstance = ReturnType<DiagramPlugin["getMermaid"]>;
type MermaidConfig = Parameters<MermaidInstance["initialize"]>[0];

// mermaid is ~950 KB gzipped and @streamdown/mermaid imports it at module
// scope, so re-exporting it here would drag all of it into the chat bundle.
// Streamdown only calls getMermaid() and then awaits instance.render(), so we
// hand it a stand-in that fetches the real plugin on the first diagram —
// conversations without one never pay for it.
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

// Streamdown 2.x ships everything below as opt-in plugins — without them a
// fence renders as plain text, `$$…$$` stays literal, and CJK autolinks
// swallow the punctuation that follows them. One shared config so shiki's
// highlighter (and its lazily loaded grammars) initializes once, not per
// message.
//
// `math` keeps the plugin's own `singleDollarTextMath: false`: enabling it
// makes prose like "$5 and $10" parse as math and render as "5and". `$$…$$`
// works inline and as a display block either way, which is what models
// actually emit for anything non-trivial.
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
