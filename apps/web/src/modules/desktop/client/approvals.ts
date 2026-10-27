import type { PermissionLevel } from "~/modules/chat/schema.ts";
import { m } from "~/paraglide/messages.js";
import type { ApprovalKind } from "../tool-schema.ts";

export { approvalKind, type ApprovalKind } from "../tool-schema.ts";
export type { PermissionLevel };
/** `allow-chat` and `allow-always` answer a site or network request, for this chat or this desktop. */
export type ApprovalChoice = "allow" | "deny" | "allow-rest" | "allow-chat" | "allow-always";
/** `bind` asks which machine an unbound chat's computer runs on. */
export type PendingKind = ApprovalKind | "read" | "bind";

/**
 * Kinds a person may allow for the rest of a chat. Reads never ask, and
 * deletes, network destinations and sites are always asked one by one.
 */
export const allowsBlanket = (kind: PendingKind) =>
  kind === "edit" || kind === "command" || kind === "browser-action";

/**
 * How a new call starts. A site is decided per address: the server may have
 * vouched for it, else the desktop knows whether it is allowed, which takes a
 * moment, so it is checked before anything is shown.
 */
export const firstDecision = (
  kind: ApprovalKind | null,
  level: PermissionLevel,
  granted: boolean,
  preauthorized: boolean,
): "run" | "ask" | "check-site" => {
  switch (kind) {
    case "site":
      return preauthorized ? "run" : "check-site";
    case "network":
    case "delete":
      return "ask";
    case null:
      return "run";
    default:
      return level === "allow" || granted ? "run" : "ask";
  }
};

export const PERMISSION_LEVELS: ReadonlyArray<{
  value: PermissionLevel;
  label: () => string;
  description: () => string;
}> = [
  {
    value: "ask",
    label: m.desktop_permission_ask,
    description: m.desktop_permission_ask_description,
  },
  {
    value: "review",
    label: m.desktop_permission_review,
    description: m.desktop_permission_review_description,
  },
  {
    value: "allow",
    label: m.desktop_permission_allow,
    description: m.desktop_permission_allow_description,
  },
];
