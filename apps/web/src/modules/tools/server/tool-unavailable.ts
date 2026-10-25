import { Schema } from "effect";
import { type Localized, localized } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";

/**
 * A tool the attempt asked for that it may not have. `reason` is a code the
 * callers set ("disabled", "not permitted"); `unavailableReason` words it.
 */
export class ToolUnavailable extends Schema.TaggedError<ToolUnavailable>()("ToolUnavailable", {
  tool: Schema.String,
  reason: Schema.String,
}) {}

/** What the page says about a refused tool, one whole sentence per case. */
export const unavailableReason = ({ tool, reason }: ToolUnavailable): Localized => {
  if (tool === "deep_research")
    return localized(
      reason === "not permitted"
        ? m.tools_error_research_not_permitted
        : m.tools_error_research_needs_search,
    );
  if (tool === "read_url") return localized(m.tools_error_url_reader_off);
  if (reason === "not configured") return localized(m.tools_error_web_search_not_configured);
  if (reason === "not permitted") return localized(m.tools_error_web_search_not_permitted);
  if (reason === "disabled" || reason === "not enabled")
    return localized(m.tools_error_web_search_off);
  return localized(m.tools_error_web_search_unavailable, { reason });
};
