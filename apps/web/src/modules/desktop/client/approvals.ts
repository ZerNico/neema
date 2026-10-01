import type { PermissionLevel } from "~/modules/chat/schema.ts";
import type { ApprovalKind } from "../tool-schema.ts";

export { approvalKind, type ApprovalKind } from "../tool-schema.ts";
export type { PermissionLevel };
/** `allow-site` and `allow-always` answer a site request, for this chat or this desktop. */
export type ApprovalChoice = "allow" | "deny" | "allow-rest" | "allow-site" | "allow-always";
export type PendingKind = ApprovalKind | "read";

/**
 * Kinds a person may allow for the rest of a chat. Reads follow the Work level,
 * and deletes, network destinations and sites are always asked one by one.
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
      return level === "manual" ? "ask" : "run";
    default:
      return level === "skip" || granted ? "run" : "ask";
  }
};

export const PERMISSION_LEVELS: ReadonlyArray<{
  value: PermissionLevel;
  label: string;
  description: string;
}> = [
  {
    value: "manual",
    label: "Approve each action",
    description: "Ask before reads, changes, and commands unless already allowed for this chat.",
  },
  {
    value: "auto",
    label: "Auto-approve reads",
    description: "Allow reading, listing, and searching. Ask before changes and commands.",
  },
  {
    value: "skip",
    label: "Auto-approve reads and changes",
    description:
      "Allow reading, editing, moving files, and running commands without asking. Network access still needs separate approval.",
  },
];
