import { m } from "~/paraglide/messages.js";
import { Link01Icon } from "@hugeicons/core-free-icons";
import { useCallback } from "react";
import type { ToolSource } from "../client/use-message-stream.ts";
import { SourcesPanelBody } from "./sources-panel.tsx";
import { type DetailPanelRequest } from "~/ui/detail-panel";
import { useDetailPanel } from "~/ui/detail-panel-context.ts";

export const SOURCES_PREFIX = "sources:";

export const sourcesRequest = (messageId: string, sources: ToolSource[]): DetailPanelRequest => ({
  id: `${SOURCES_PREFIX}${messageId}`,
  title: m.chat_sources_panel_title(),
  subtitle: `${sources.length}`,
  icon: Link01Icon,
  restorable: true,
  body: <SourcesPanelBody sources={sources} />,
});

/**
 * Opens this message's sources in the detail panel.
 *
 * `sources` is snapshotted into the panel body on each open; `SourcesPanelOwner`
 * keeps an open tab current from then on.
 */
export function useSourcesPanel(messageId: string, sources: ToolSource[]) {
  const panel = useDetailPanel();
  return useCallback(
    () => panel.open(sourcesRequest(messageId, sources)),
    [panel, messageId, sources],
  );
}
