import { Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import {
  DesktopToolResult,
  desktopToolTimeout,
  type DesktopToolName,
} from "~/modules/desktop/tool-schema.ts";
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
    "Read a tab as an outline of what is on it: headings, text, links, buttons and fields, each with a reference like [e12]. Set screenshot to also see the visible part of the page; only you see it. Set share when the user asks to see the page: the screenshot is then attached to your answer for them, and stored with the chat. Set save to write it into this chat's workspace on the user's computer instead, for files or commands to use; the user is not shown it.",
  parameters: Schema.Struct({
    tab: optional(Tab),
    screenshot: optional(Schema.Boolean),
    share: optional(Schema.Boolean),
    save: optional(Schema.Boolean),
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

const Ref = Schema.String.annotate({
  description: "An element reference from the latest browser_snapshot, like e12.",
});

export const browserClickTool = Tool.make("browser_click", {
  description:
    "Click an element of a tab, by its reference from the latest browser_snapshot; or, for something the outline does not name (a canvas, a map), at x and y in the screenshot's pixels. Snapshot again afterwards to see what changed.",
  parameters: Schema.Struct({
    tab: optional(Tab),
    ref: optional(Ref),
    x: optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    y: optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const browserTypeTool = Tool.make("browser_type", {
  description:
    "Type text into a field of a tab, by its reference. clear replaces what is there; submit presses Enter afterwards. Set sensitive for a password or other secret the user gave you for this site, so it is never shown, not even to approve it. A password field refuses text that is not marked sensitive.",
  parameters: Schema.Struct({
    tab: optional(Tab),
    ref: optional(Ref),
    text: optional(Schema.String),
    clear: optional(Schema.Boolean),
    submit: optional(Schema.Boolean),
    sensitive: optional(Schema.Boolean),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const browserPressTool = Tool.make("browser_press", {
  description: 'Press a key in a tab, like "Enter", "Escape", "Tab", "ArrowDown" or "Control+A".',
  parameters: Schema.Struct({ tab: optional(Tab), key: optional(Schema.String) }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const browserScrollTool = Tool.make("browser_scroll", {
  description:
    "Scroll a tab by deltaY pixels (positive is down) and deltaX pixels (positive is right). Give ref to scroll a scrollable element instead of the page. Clicking and typing scroll their element into view by themselves.",
  parameters: Schema.Struct({
    tab: optional(Tab),
    deltaY: optional(Schema.Int),
    deltaX: optional(Schema.Int),
    ref: optional(Ref),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const browserSaveTool = Tool.make("browser_save", {
  description:
    "Save files from the web into this chat's workspace on the user's computer: images, PDFs or anything else, by their absolute addresses (up to 50). They are fetched with the tab's session, so files behind the user's logins come too, and no page rules get in the way. Sites other than the tab's own and those allowed in this chat ask the user first. Returns where each file landed.",
  parameters: Schema.Struct({
    tab: optional(Tab),
    urls: optional(Schema.Array(Url)),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const browserSelectTool = Tool.make("browser_select", {
  description:
    "Choose an option of a dropdown in a tab, by the dropdown's reference and the option's value or label.",
  parameters: Schema.Struct({
    tab: optional(Tab),
    ref: optional(Ref),
    value: optional(Schema.String),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const browserEvaluateTool = Tool.make("browser_evaluate", {
  description:
    "Run a JavaScript expression against a tab's page and get its value back as JSON, for reading data the outline does not show (a table, a list, a hidden value). It sees the page's DOM but none of its scripts' variables. The user sees the code before it runs. Prefer the other tools for clicking and typing. A download it starts (an <a download> link it creates and clicks) lands in this chat's workspace.",
  parameters: Schema.Struct({ tab: optional(Tab), expression: optional(Schema.String) }),
  success: DesktopToolResult,
  failureMode: "return",
});

/**
 * Offered only to Work attempts from a desktop app with a browser. Like the
 * file tools, the handlers only wait: the page runs each call in its own tabs.
 */
export const prepareBrowserTools = (deps: Pick<DesktopToolDeps, "rowIdFor">): ToolGroup => {
  const handle = (name: DesktopToolName) =>
    awaitDesktopCall(deps.rowIdFor, name, desktopToolTimeout(name));
  return {
    toolkit: Toolkit.make(
      browserTabsTool,
      browserOpenTool,
      browserNavigateTool,
      browserSnapshotTool,
      browserWaitForTool,
      browserClickTool,
      browserTypeTool,
      browserPressTool,
      browserScrollTool,
      browserSelectTool,
      browserEvaluateTool,
      browserSaveTool,
    ),
    handlers: {
      browser_tabs: handle("browser_tabs"),
      browser_open: handle("browser_open"),
      browser_navigate: handle("browser_navigate"),
      browser_snapshot: handle("browser_snapshot"),
      browser_wait_for: handle("browser_wait_for"),
      browser_click: handle("browser_click"),
      browser_type: handle("browser_type"),
      browser_press: handle("browser_press"),
      browser_scroll: handle("browser_scroll"),
      browser_select: handle("browser_select"),
      browser_evaluate: handle("browser_evaluate"),
      browser_save: handle("browser_save"),
    },
  };
};
