import { Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { DESKTOP_TIMEOUTS, DesktopToolResult } from "~/modules/desktop/tool-schema.ts";
import { awaitDesktopCall, type DesktopToolDeps } from "~/modules/desktop/server/tools.ts";
import { advertisedParameter, type ToolGroup } from "~/modules/tools/server/toolset.ts";

// Every key optional on the wire: a model that omits or mistypes one gets an
// explanation from the page instead of failing the whole stream at decode.
const optional = <S extends Schema.Top>(schema: S) =>
  advertisedParameter(Schema.toJsonSchemaDocument(schema).schema);

const Tab = Schema.String.annotate({
  description: 'A tab of this chat, as browser_tabs names it: "t1", "t2", …',
});
const Url = Schema.String.annotate({ description: "An absolute http(s) address." });

export const browserTabsTool = Tool.make("browser_tabs", {
  description:
    "List this chat's browser tabs: their names (t1, t2, …), addresses and titles, and which one is shown.",
  parameters: Tool.EmptyParams,
  success: DesktopToolResult,
  failureMode: "return",
});

export const browserOpenTool = Tool.make("browser_open", {
  description:
    "Open a page in a new browser tab of this chat and wait for it to load. Returns the tab's name for the other browser tools.",
  parameters: Schema.Struct({ url: optional(Url) }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const browserNavigateTool = Tool.make("browser_navigate", {
  description:
    "Load an address in an existing tab, or go back, forward or reload it, and wait for it to load.",
  parameters: Schema.Struct({
    tab: optional(Tab),
    url: optional(Url),
    action: optional(Schema.Literals(["back", "forward", "reload"])),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const browserSnapshotTool = Tool.make("browser_snapshot", {
  description:
    "Read a tab as an outline of what is on it: headings, text, links, buttons and fields, each with a reference like [e12]. Set screenshot to also see the visible part of the page.",
  parameters: Schema.Struct({
    tab: optional(Tab),
    screenshot: optional(Schema.Boolean),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const browserWaitForTool = Tool.make("browser_wait_for", {
  description:
    "Wait until a tab shows some text, or its address contains some text, for up to timeoutMs (at most 30000).",
  parameters: Schema.Struct({
    tab: optional(Tab),
    text: optional(Schema.String),
    urlIncludes: optional(Schema.String),
    timeoutMs: optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(30_000)),
    ),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

/**
 * Offered only to Work attempts from a desktop app with a browser. Like the
 * file tools, the handlers only wait: the page runs each call in its own tabs.
 */
export const prepareBrowserTools = (deps: Pick<DesktopToolDeps, "rowIdFor">): ToolGroup => {
  const handle = (name: string, timeoutMs: number) =>
    awaitDesktopCall(deps.rowIdFor, name, timeoutMs);
  return {
    toolkit: Toolkit.make(
      browserTabsTool,
      browserOpenTool,
      browserNavigateTool,
      browserSnapshotTool,
      browserWaitForTool,
    ),
    handlers: {
      browser_tabs: handle("browser_tabs", DESKTOP_TIMEOUTS.quick),
      // Opening a site can wait on a person deciding.
      browser_open: handle("browser_open", DESKTOP_TIMEOUTS.command),
      browser_navigate: handle("browser_navigate", DESKTOP_TIMEOUTS.command),
      browser_snapshot: handle("browser_snapshot", DESKTOP_TIMEOUTS.quick),
      browser_wait_for: handle("browser_wait_for", DESKTOP_TIMEOUTS.quick),
    },
  };
};
