import { useIntegrationDirectory } from "~/modules/integrations/client/directory.ts";
import { Book02Icon, FolderLibraryIcon, Image02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { IntegrationTag } from "~/modules/integrations/ui/integration-mention-text.tsx";
import { inlineTagClassName } from "~/ui/inline-tag.ts";
import type { Mentionable } from "~/modules/integrations/mentions.ts";
import { splitMessageTags, type ContextTag } from "../tags.ts";

const TAG_ICONS = { skill: Book02Icon, collection: FolderLibraryIcon, image: Image02Icon } as const;

/** A /skill, #collection or image tag, in the composer or the sent message. */
export function ContextTagView({ tag, tone }: { tag: ContextTag; tone: "message" | "field" }) {
  return (
    <span className={inlineTagClassName(tone)}>
      <HugeiconsIcon
        icon={TAG_ICONS[tag.kind]}
        strokeWidth={2}
        className="size-3.5 shrink-0"
        aria-hidden
      />
      {tag.name}
    </span>
  );
}

/**
 * Sent message text with its skill, collection and integration tags drawn as
 * tags. The stored words are unchanged for the model and for copying.
 */
export function MessageTagText({ text }: { text: string }) {
  // Only text that could hold an "@Name" needs the integrations' names.
  return text.includes("@") ? (
    <MentionedText text={text} />
  ) : (
    <TaggedText text={text} integrations={[]} />
  );
}

function MentionedText({ text }: { text: string }) {
  return <TaggedText text={text} integrations={useIntegrationDirectory().list} />;
}

function TaggedText({ text, integrations }: { text: string; integrations: Mentionable }) {
  return splitMessageTags(text, integrations).map((segment) =>
    segment.kind === "tag" ? (
      <ContextTagView key={segment.start} tag={segment.tag} tone="message" />
    ) : segment.kind === "integration" ? (
      <IntegrationTag
        key={segment.start}
        integrationId={segment.integrationId}
        fallback={segment.text}
        tone="message"
      />
    ) : (
      segment.text
    ),
  );
}
