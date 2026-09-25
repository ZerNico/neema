import { cn } from "~/ui/utils";
import { findIntegration } from "../catalog.ts";
import { splitIntegrationMentions } from "../mentions.ts";
import { IntegrationLogo } from "./integration-logo.tsx";

/**
 * An `@Name` integration mention as a tag. One element for the sent message and
 * the composer, so the two never drift; `tone` only picks the tint that reads on
 * each surface (the message bubble is filled with the primary colour).
 */
export function IntegrationTag({
  integrationId,
  fallback,
  tone,
}: {
  integrationId: string;
  /** What was typed, shown if the integration is no longer in the catalog. */
  fallback: string;
  tone: "message" | "field";
}) {
  return (
    <span
      className={cn(
        "mx-px inline-flex items-center gap-1 rounded-md px-1.5 align-bottom font-medium",
        tone === "message" ? "bg-primary-foreground/15" : "bg-muted text-foreground",
      )}
    >
      <IntegrationLogo integrationId={integrationId} className="size-3.5" />
      {findIntegration(integrationId)?.name ?? fallback}
    </span>
  );
}

/**
 * Message text with each `@Name` integration mention drawn as a tag. The words
 * are unchanged for the model and for copying; this is only how they read.
 */
export function IntegrationMentionText({ text }: { text: string }) {
  return splitIntegrationMentions(text).map((segment) =>
    segment.kind === "mention" ? (
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
