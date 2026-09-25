import { inlineTagClassName } from "~/ui/inline-tag.ts";
import { findIntegration } from "../catalog.ts";
import { IntegrationLogo } from "./integration-logo.tsx";

/** An `@Name` integration mention as a tag, in the composer or the sent message. */
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
    <span className={inlineTagClassName(tone)}>
      <IntegrationLogo integrationId={integrationId} className="size-3.5" />
      {findIntegration(integrationId)?.name ?? fallback}
    </span>
  );
}
