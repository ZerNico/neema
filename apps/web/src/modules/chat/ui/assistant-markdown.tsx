import { memo, useMemo, type ComponentProps } from "react";
import { markdownTableComponents } from "~/ui/markdown-components.ts";
import UiBlockFrame from "~/modules/genui/ui/frame.tsx";
import { Streamdown, defaultRehypePlugins, type ExtraProps, type PluginConfig } from "streamdown";
import { FileReferenceLink } from "./file-reference.tsx";
import { isFileReferenceHref } from "../file-references.ts";
import { markdownReferenceLinks } from "./markdown-reference-links.ts";
import { markdownPlugins } from "~/ui/markdown-plugins.ts";
import { cn } from "~/ui/utils";
import { stripUndefinedCitationMarkers } from "../citation-markers.ts";
import { LINK_SAFETY } from "~/ui/link-safety.tsx";

export type MarkdownComponents = NonNullable<ComponentProps<typeof Streamdown>["components"]>;

export function MarkdownReferenceSpan({
  node,
  children,
  ...props
}: ComponentProps<"span"> & ExtraProps) {
  const href = node?.data && "referenceHref" in node.data ? node.data.referenceHref : undefined;
  if (typeof href === "string" && isFileReferenceHref(href))
    return <FileReferenceLink href={href}>{children}</FileReferenceLink>;
  return <span {...props}>{children}</span>;
}

const referenceComponents: MarkdownComponents = {
  span: MarkdownReferenceSpan,
  ...markdownTableComponents,
};

// ```ui fences are interactive blocks in answers only: reasoning, file and
// skill previews keep the shared plugins and show the source as code.
// The frame is small and eager; the block behind it loads on first use.
const answerPlugins: PluginConfig = {
  ...markdownPlugins,
  renderers: [{ language: "ui", component: UiBlockFrame }],
};

/**
 * How an answer's markdown renders. Model-authored markdown in the transcript
 * goes through here, so a plugin or typography change lands in every answer
 * at once instead of drifting per feature.
 */
export const AssistantMarkdown = memo(function AssistantMarkdown({
  content: rawContent,
  components,
  hasCitations = false,
  streaming,
  className,
}: {
  content: string;
  components?: MarkdownComponents;
  hasCitations?: boolean;
  streaming: boolean;
  className?: string;
}) {
  // File components are always present; only a source list backs citations.
  const content = useMemo(
    () => (hasCitations ? rawContent : stripUndefinedCitationMarkers(rawContent)),
    [hasCitations, rawContent],
  );
  const rehypePlugins = useMemo<NonNullable<ComponentProps<typeof Streamdown>["rehypePlugins"]>>(
    () => [
      ...Object.values(defaultRehypePlugins),
      [markdownReferenceLinks, { citations: hasCitations }],
    ],
    [hasCitations],
  );
  const renderedComponents = useMemo(
    () => ({ ...referenceComponents, ...components }),
    [components],
  );
  return (
    <Streamdown
      linkSafety={LINK_SAFETY}
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown
      plugins={answerPlugins}
      isAnimating={streaming}
      animated={{ animation: "fadeIn", duration: 200, easing: "ease-out", stagger: 0 }}
      components={renderedComponents}
      rehypePlugins={rehypePlugins}
      className={cn("space-y-3 [&_pre]:overflow-x-auto", className)}
    >
      {content}
    </Streamdown>
  );
});
