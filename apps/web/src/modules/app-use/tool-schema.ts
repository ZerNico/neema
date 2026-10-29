/**
 * App use: the model operating apps on the person's own machine (docs/internals/app-use.md).
 * Desktop tools in family, envelope and result shape, run by the chat's machine like the
 * computer's, but they never touch its VM. Consent is per app and asked at the machine, so the
 * server asks nothing per call.
 */
export const APP_TOOL_NAMES = [
  "app_list",
  "app_open",
  "app_look",
  "app_click",
  "app_type",
  "app_key",
  "app_scroll",
  "app_drag",
  "app_zoom",
] as const;
export type AppToolName = (typeof APP_TOOL_NAMES)[number];
export const isAppTool = (name: string): name is AppToolName =>
  (APP_TOOL_NAMES as ReadonlyArray<string>).includes(name);

/**
 * Whether a machine can use the person's apps: its shell says it has an app driver. A shell older
 * than saying so has one only on a Mac; an old Windows shell has none, nor a build without Rust.
 */
export const drivesApps = (machine: {
  readonly platform: "darwin" | "win32" | "linux";
  readonly apps?: boolean | null | undefined;
}) => machine.apps ?? machine.platform === "darwin";

/** The app a call names, as stored: a bundle id or the name the model used. */
export const appOfArgs = (args: Readonly<Record<string, unknown>> | undefined) =>
  typeof args?.app === "string" ? args.app : "";

/**
 * What the model is told about app use. The mechanics are in the tool descriptions; this
 * carries the rules that span them.
 */
export const APP_TOOLS_SYSTEM_HINT = [
  "You can operate apps on the user's own computer (Excel, Mail, Finder, a calculator, a company's desktop app): the app family, loaded with load_tools before the first call. This is what people call computer use: when the user asks for computer use, or for something done in an app on their computer, use these tools. It is neither the browser nor this chat's computer, the Linux VM for files and commands. Without such a request, use it for work only an app can do; prefer files, commands, the browser and integrations when they reach the same thing.",
  "Look before acting and look again after: every action returns a fresh look, and references are valid only for the look that made them. Act by reference where the outline names the element; use x and y on the picture for what it does not.",
  "The first use of an app asks the user at their computer. A refusal is an answer: do not retry it or reach the app another way. Terminals, password managers and system settings are never available.",
  "Stop and ask the user before sending, buying, deleting, or anything else done as them that cannot be undone, and for logins, codes and payments. Never type a password the user did not give you for that app in this chat.",
].join("\n");
