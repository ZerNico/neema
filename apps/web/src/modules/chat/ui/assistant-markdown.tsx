import { memo, useMemo, type ComponentProps } from "react";
import { Streamdown, defaultRehypePlugins, type ExtraProps } from "streamdown";
import { FileReferenceLink } from "./file-reference.tsx";
import { isFileReferenceHref } from "../file-references.ts";
import { markdownReferenceLinks } from "./markdown-reference-links.ts";
import { markdownPlugins } from "~/ui/markdown-plugins.ts";
import { cn } from "~/ui/utils";
import { stripUndefinedCitationMarkers } from "../citation-markers.ts";

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

const referenceComponents: MarkdownComponents = { span: MarkdownReferenceSpan };

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
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown
      plugins={markdownPlugins}
      isAnimating={streaming}
      animated={{ animation: "fadeIn", duration: 200, easing: "ease-out", stagger: 0 }}
      // Streamdown caps tables at 300px and scrolls them inside the transcript's
      // own scroll, which hid most rows and caught the wheel. A table is read,
      // so it takes its full height; wide ones still scroll sideways.
      tableMaxHeight={0}
      components={renderedComponents}
      rehypePlugins={rehypePlugins}
      className={cn("space-y-3 [&_pre]:overflow-x-auto", className)}
    >
      {content}
    </Streamdown>
  );
});
