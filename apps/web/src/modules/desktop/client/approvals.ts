import type { PermissionLevel } from "~/modules/chat/schema.ts";
import type { ApprovalKind } from "../tool-schema.ts";

export { approvalKind, type ApprovalKind } from "../tool-schema.ts";
export type { PermissionLevel };
export type ApprovalChoice = "allow" | "deny" | "allow-rest";
export type PendingKind = ApprovalKind | "read";

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
