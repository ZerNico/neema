import { code } from "@streamdown/code";
import type { ComponentProps } from "react";
import type { Streamdown } from "streamdown";

type PluginConfig = NonNullable<ComponentProps<typeof Streamdown>["plugins"]>;

// Streamdown 2.x ships syntax highlighting as an opt-in plugin — without it a
// fence renders as plain text and every token falls back to `--sdm-c: inherit`.
// One shared config so shiki's highlighter (and the grammars it loads lazily,
// per language) initializes once rather than per message.
export const markdownPlugins: PluginConfig = { code };
