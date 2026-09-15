import { memo, useMemo, type ComponentProps } from "react";
import { Streamdown } from "streamdown";
import { markdownPlugins } from "~/ui/markdown-plugins.ts";
import { cn } from "~/ui/utils";
import { stripUndefinedCitationMarkers } from "../citation-markers.ts";

export type MarkdownComponents = NonNullable<ComponentProps<typeof Streamdown>["components"]>;

/**
 * The one markdown surface in the app. Anything showing model-authored markdown
 * (an answer, a conversation document) renders through here, so a plugin or
 * typography change lands everywhere at once instead of drifting per feature.
 */
export const AssistantMarkdown = memo(function AssistantMarkdown({
  content: rawContent,
  components,
  streaming,
  className,
}: {
  content: string;
  components?: MarkdownComponents;
  streaming: boolean;
  className?: string;
}) {
  // No source list (no components override) means any `[^N]` the model wrote
  // has nothing to resolve against and would render as literal text, which
  // happens when it imitates a cited turn earlier in the conversation. Markers
  // it backed with its own definitions are real footnotes and stay.
  const content = useMemo(
    () => (components ? rawContent : stripUndefinedCitationMarkers(rawContent)),
    [components, rawContent],
  );
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown
      plugins={markdownPlugins}
      isAnimating={streaming}
      animated={{ animation: "fadeIn", duration: 200, easing: "ease-out", stagger: 0 }}
      {...(components ? { components } : {})}
      className={cn("space-y-3 [&_pre]:overflow-x-auto", className)}
    >
      {content}
    </Streamdown>
  );
});
