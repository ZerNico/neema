import { Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { awaitDesktopCall, type DesktopToolDeps } from "~/modules/desktop/server/tools.ts";
import {
  DesktopToolResult,
  desktopToolTimeout,
  type DesktopToolName,
} from "~/modules/desktop/tool-schema.ts";
import { advertisedAs, type ToolGroup } from "~/modules/tools/server/toolset.ts";

// Every parameter decodes anything, absent included: the machine explains a malformed call,
// where a strict schema would fail the whole answer before any handler ran.
const App = advertisedAs(
  Schema.String.annotate({
    description: 'The app, as app_list names it: its id like "com.microsoft.Excel", or its name.',
  }),
);
const Ref = advertisedAs(
  Schema.String.annotate({ description: "An element reference from the latest look, like e12." }),
);
const Pixel = advertisedAs(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));

export const appListTool = Tool.make("app_list", {
  description:
    "List the apps running on the user's computer and their windows, with which ones this chat may already use. Apps that are never available are left out.",
  parameters: Tool.EmptyParams,
  success: DesktopToolResult,
  failureMode: "return",
});

export const appOpenTool = Tool.make("app_open", {
  description:
    "Open an app on the user's computer, behind what they are doing, and look at it. The first use of an app asks the user.",
  parameters: Schema.Struct({ app: App }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const appLookTool = Tool.make("app_look", {
  description:
    "Look at an app's window: a picture of that window alone and an outline of its controls, each with a reference like e12 and its position @x,y in the picture's pixels. Only you see the picture.",
  parameters: Schema.Struct({ app: App }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const appClickTool = Tool.make("app_click", {
  description:
    "Click in an app's window: an element by its reference, or a point by x and y in the latest look's picture, for what the outline does not name. button right opens a context menu; count 2 double-clicks. Returns a fresh look.",
  parameters: Schema.Struct({
    app: App,
    ref: Ref,
    x: Pixel,
    y: Pixel,
    button: advertisedAs(Schema.Literals(["left", "right", "middle"])),
    count: advertisedAs(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
    modifiers: advertisedAs(
      Schema.Array(Schema.Literals(["cmd", "shift", "alt", "ctrl"])).annotate({
        description: "Keys held while clicking.",
      }),
    ),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const appTypeTool = Tool.make("app_type", {
  description:
    "Type text into an app: into the element by its reference, focused first, or wherever its focus is. replace sets a field's whole value instead of typing into it. Returns a fresh look.",
  parameters: Schema.Struct({
    app: App,
    text: advertisedAs(Schema.String),
    ref: Ref,
    replace: advertisedAs(Schema.Boolean),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const appKeyTool = Tool.make("app_key", {
  description:
    'Press a key or shortcut in an app, like "Return", "Escape", "Tab", "Down", "cmd+s" or "cmd+shift+t". Returns a fresh look.',
  parameters: Schema.Struct({ app: App, keys: advertisedAs(Schema.String) }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const appScrollTool = Tool.make("app_scroll", {
  description:
    "Scroll what is under an element or a point of an app's window, by lines (default 5). Returns a fresh look.",
  parameters: Schema.Struct({
    app: App,
    direction: advertisedAs(Schema.Literals(["up", "down", "left", "right"])),
    amount: advertisedAs(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
    ref: Ref,
    x: Pixel,
    y: Pixel,
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

const Place = Schema.Struct({
  ref: Schema.optionalKey(Schema.String),
  x: Schema.optionalKey(Schema.Int),
  y: Schema.optionalKey(Schema.Int),
}).annotate({
  description: "An element by ref, or a point by x and y in the latest look's picture.",
});

export const appDragTool = Tool.make("app_drag", {
  description:
    "Drag in an app's window from one element or point to another: a slider, a selection, a file onto a folder. Returns a fresh look.",
  parameters: Schema.Struct({ app: App, from: advertisedAs(Place), to: advertisedAs(Place) }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const appZoomTool = Tool.make("app_zoom", {
  description:
    "See part of the latest look at full resolution, for small text or fine detail: a rectangle in the picture's pixels.",
  parameters: Schema.Struct({ app: App, x: Pixel, y: Pixel, width: Pixel, height: Pixel }),
  success: DesktopToolResult,
  failureMode: "return",
});

/**
 * Offered once the person has a Mac or a Windows PC connected, the platforms with a driver. Like
 * the computer's tools, the handlers only wait: the chat's machine runs each call.
 */
export const prepareAppTools = (deps: Pick<DesktopToolDeps, "rowIdFor">): ToolGroup => {
  const handle = (name: DesktopToolName) =>
    awaitDesktopCall(deps.rowIdFor, name, desktopToolTimeout(name));
  return {
    family: "desktop",
    toolkit: Toolkit.make(
      appListTool,
      appOpenTool,
      appLookTool,
      appClickTool,
      appTypeTool,
      appKeyTool,
      appScrollTool,
      appDragTool,
      appZoomTool,
    ),
    handlers: {
      app_list: handle("app_list"),
      app_open: handle("app_open"),
      app_look: handle("app_look"),
      app_click: handle("app_click"),
      app_type: handle("app_type"),
      app_key: handle("app_key"),
      app_scroll: handle("app_scroll"),
      app_drag: handle("app_drag"),
      app_zoom: handle("app_zoom"),
    },
  };
};
