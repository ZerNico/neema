import { Schema } from "effect";

/**
 * The wire between the desktop app and a platform's app driver
 * (native/app-driver/<platform>): one JSON request per line on its stdin, one response per
 * line on its stdout. Both drivers implement exactly this; everything above it is shared.
 */

/** Platform roles (AX on macOS, UI Automation on Windows) map onto these; the rest are `other`. */
export const Role = Schema.Literals([
  "window",
  "dialog",
  "sheet",
  "toolbar",
  "menuBar",
  "menu",
  "menuItem",
  "button",
  "closeButton",
  "minimizeButton",
  "zoomButton",
  "checkbox",
  "radio",
  "switch",
  "popUpButton",
  "comboBox",
  "textField",
  "textArea",
  "searchField",
  "slider",
  "link",
  "tabGroup",
  "tab",
  "table",
  "row",
  "column",
  "cell",
  "list",
  "listItem",
  "outline",
  "treeItem",
  "scrollArea",
  "group",
  "image",
  "text",
  "heading",
  "webArea",
  "other",
]);
export type Role = typeof Role.Type;

/** What an element can be told to do, in either platform's terms. */
export const Action = Schema.Literals(["press", "showMenu", "increment", "decrement", "setValue"]);
export type Action = typeof Action.Type;

/**
 * One element of a window, in preorder: a node's children follow it at `depth + 1`. `id`
 * names the element until the driver's next look. The frame is in window points.
 */
export const UiNode = Schema.Struct({
  id: Schema.String,
  depth: Schema.Number,
  role: Role,
  name: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.String),
  frame: Schema.optionalKey(
    Schema.Struct({
      x: Schema.Number,
      y: Schema.Number,
      width: Schema.Number,
      height: Schema.Number,
    }),
  ),
  actions: Schema.Array(Action),
  disabled: Schema.optionalKey(Schema.Boolean),
  focused: Schema.optionalKey(Schema.Boolean),
});
export type UiNode = typeof UiNode.Type;

export const Permissions = Schema.Struct({
  /** Reading and acting on other apps' elements. Always true where nothing gates it. */
  accessibility: Schema.Boolean,
  /** Capturing other apps' windows. */
  capture: Schema.Boolean,
  /** Coordinate input reaches a covered window without raising it. Else it is not offered. */
  background: Schema.Boolean,
});

export const RunningApp = Schema.Struct({
  /** The bundle id on macOS, the executable's AppUserModelID or path on Windows. */
  appId: Schema.String,
  name: Schema.String,
  pid: Schema.Number,
  front: Schema.Boolean,
  offLimits: Schema.Boolean,
});
export type RunningApp = typeof RunningApp.Type;

/** A PNG, at most 1280 px on its long edge. */
export const Picture = Schema.Struct({
  data: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
});

/** A point in window points. */
export const Point = Schema.Struct({ x: Schema.Number, y: Schema.Number });
/** Where pointer input lands: a point, or the centre of a node of the latest look. */
export const Place = Schema.Union([Point, Schema.Struct({ node: Schema.String })]);

export const Look = Schema.Struct({
  app: Schema.String,
  title: Schema.NullOr(Schema.String),
  /** The window's size in points; node frames are relative to its top-left corner. */
  window: Schema.Struct({ width: Schema.Number, height: Schema.Number }),
  /** The window alone. */
  image: Picture,
  nodes: Schema.Array(UiNode),
  /** The driver stopped walking at its node cap. */
  truncated: Schema.Boolean,
});
export type Look = typeof Look.Type;

export const DriverErrorCode = Schema.Literals([
  "bad_request",
  "unknown_method",
  "invalid_params",
  "off_limits",
  "not_installed",
  "not_running",
  "no_window",
  "no_look",
  "no_frame",
  "stale_node",
  "action_failed",
  "window_not_key",
  "screen_locked",
  "capture_failed",
  "failed",
]);
export type DriverErrorCode = typeof DriverErrorCode.Type;

export const Methods = {
  permissions: { params: Schema.Struct({}), result: Permissions },
  apps: { params: Schema.Struct({}), result: Schema.Struct({ apps: Schema.Array(RunningApp) }) },
  /** `pid` picks one instance where several share a bundle id, as Electron apps in development do. */
  look: {
    params: Schema.Struct({ appId: Schema.String, pid: Schema.optionalKey(Schema.Number) }),
    result: Look,
  },
  /** Which app a bundle id or name means, running or installed, without starting it. */
  resolve: {
    params: Schema.Struct({ app: Schema.String }),
    result: Schema.Struct({ appId: Schema.String, name: Schema.String, running: Schema.Boolean }),
  },
  /** By bundle id, or by the name a person calls the app. */
  open: {
    params: Schema.Struct({ appId: Schema.String }),
    result: Schema.Struct({ name: Schema.String, pid: Schema.Number, appId: Schema.String }),
  },
  /** Part of the latest look's window, in window points, at full resolution. */
  zoom: {
    params: Schema.Struct({
      region: Schema.Struct({
        x: Schema.Number,
        y: Schema.Number,
        width: Schema.Number,
        height: Schema.Number,
      }),
    }),
    result: Picture,
  },
  /** A plain left click on a node that can be pressed is an accessibility press, no pointer. */
  click: {
    params: Schema.Struct({
      node: Schema.optionalKey(Schema.String),
      at: Schema.optionalKey(Point),
      button: Schema.optionalKey(Schema.Literals(["left", "right", "middle"])),
      count: Schema.optionalKey(Schema.Number),
      modifiers: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
    result: Schema.Struct({}),
  },
  setValue: {
    params: Schema.Struct({ node: Schema.String, value: Schema.String }),
    result: Schema.Struct({}),
  },
  /** Into the node, focused first, or wherever the app's focus is. */
  type: {
    params: Schema.Struct({ node: Schema.optionalKey(Schema.String), text: Schema.String }),
    result: Schema.Struct({}),
  },
  /** `cmd+s`, `Return`, `ctrl+Tab`; letters on the current keyboard layout. */
  key: { params: Schema.Struct({ keys: Schema.String }), result: Schema.Struct({}) },
  /** By lines; positive y reveals what is above, as a wheel does. */
  scroll: {
    params: Schema.Struct({
      at: Place,
      x: Schema.optionalKey(Schema.Number),
      y: Schema.optionalKey(Schema.Number),
    }),
    result: Schema.Struct({}),
  },
  drag: { params: Schema.Struct({ from: Place, to: Place }), result: Schema.Struct({}) },
  /**
   * A panel inside System Settings to drag `bundle` into a privacy list. Answers once the grant
   * shows, the person closes it, `cancelGuide` arrives or ten minutes pass. `preview` shows it
   * whatever is granted, to check it by eye.
   */
  guide: {
    params: Schema.Struct({
      permission: Schema.Literals(["accessibility", "screenRecording"]),
      bundle: Schema.String,
      title: Schema.String,
      instruction: Schema.String,
      preview: Schema.optionalKey(Schema.Boolean),
    }),
    result: Schema.Struct({ outcome: Schema.Literals(["granted", "closed", "timeout"]) }),
  },
  /** Closes a guide at once: the driver answers it ahead of the guide it ends. */
  cancelGuide: { params: Schema.Struct({}), result: Schema.Struct({}) },
} as const;
export type Method = keyof typeof Methods;

export const Response = Schema.Struct({
  id: Schema.NullOr(Schema.Number),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ code: DriverErrorCode, message: Schema.String })),
});
