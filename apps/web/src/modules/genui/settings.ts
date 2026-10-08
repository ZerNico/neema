// What an admin allows for ```ui blocks, kept in the `interactive_ui` row of
// the tools registry. Read once per attempt, like the Office files switch, so
// a change applies to the next answer. A missing row means the defaults: on.

export const INTERACTIVE_UI_TOOL = "interactive_ui";

export interface InteractiveUiSettings {
  /** The model is offered the skill that teaches blocks. */
  readonly enabled: boolean;
  /** Image tags are looked up; still only with the attempt's web search. */
  readonly images: boolean;
}

/**
 * Off switches the whole feature off for new answers, images included.
 * Blocks already in earlier answers keep rendering: they are stored text,
 * and hiding them would change history.
 */
export function readInteractiveUi(
  tool: { readonly enabled: boolean; readonly config: Readonly<Record<string, unknown>> } | null,
): InteractiveUiSettings {
  const enabled = tool?.enabled ?? true;
  return { enabled, images: enabled && tool?.config.images !== false };
}
