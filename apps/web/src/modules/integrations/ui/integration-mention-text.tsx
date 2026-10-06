import { inlineTagClassName } from "~/ui/inline-tag.ts";
import { useIntegration } from "../client/directory.ts";
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
      {useIntegration(integrationId)?.name ?? fallback}
    </span>
  );
}

/**
 * An integration's name by id, as text. Its own component so a view showing
 * integration sources among others reads the directory only for them.
 */
export function IntegrationNameText({ integrationId }: { integrationId: string }) {
  return useIntegration(integrationId)?.name ?? integrationId;
}
