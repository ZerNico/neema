import type { ToolAccess } from "./manifest.ts";

/** One tool's standing permission on a connection, as Settings shows it. */
export type ToolPermission = "allow" | "ask" | "block";

/** What a schedule granted up front; null when a person is there to ask. */
export type UnattendedGrant = "read" | "write" | null;

export type Consent = "run" | "ask" | "refuse";

/** Reads are allowed and anything that changes the service asks, until set otherwise. */
export const defaultPermission = (access: ToolAccess): ToolPermission =>
  access === "read" ? "allow" : "ask";

export const permissionFor = (
  tool: { name: string; access: ToolAccess },
  permissions: Readonly<Record<string, ToolPermission>>,
): ToolPermission => permissions[tool.name] ?? defaultPermission(tool.access);

/**
 * The one decision table for integration calls. A blocked tool never runs.
 * With someone present the tool's own permission decides; "always allow in
 * this chat" lifts an ask there, except for a destructive tool, which only an
 * explicit "allow" in Settings runs unasked. Unattended, the schedule's grant
 * is the ceiling, destructive tools never run, and nothing waits.
 */
export const consentFor = (input: {
  access: ToolAccess;
  permission: ToolPermission;
  allowedInChat: boolean;
  unattended: UnattendedGrant;
}): Consent => {
  if (input.permission === "block") return "refuse";
  if (input.unattended !== null) {
    if (input.access === "read") return "run";
    // Deleting is never granted ahead of time: nobody would see it happen.
    if (input.access === "destructive") return "refuse";
    return input.unattended === "write" ? "run" : "refuse";
  }
  if (input.permission === "allow") return "run";
  // One approval in a chat can lift asks for changes, never for deleting.
  if (input.allowedInChat && input.access !== "destructive") return "run";
  return "ask";
};
