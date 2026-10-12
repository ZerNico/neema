import type { ToolAccess } from "./manifest.ts";

/** One tool's standing permission on a connection, as Settings shows it. */
export type ToolPermission = "allow" | "ask" | "block";

/**
 * What a schedule granted up front; null when a person is there to ask.
 * `allowances` holds, per allowance id, the exact targets it may reach.
 */
export type UnattendedGrant = {
  readonly access: "read" | "write";
  readonly allowances: Readonly<Record<string, ReadonlyArray<string>>>;
} | null;

/** The people one call would contact under an allowance, as the service has them. */
export interface Reach {
  readonly allowance: string;
  readonly targets: ReadonlyArray<string>;
}

/**
 * Why a call may not run: the person blocked the tool, the schedule's grant
 * does not reach that far, the call is destructive and nobody is there, the
 * schedule never granted this allowance, it names someone the allowance does
 * not list, or it would change something through a key everyone shares.
 */
export type Refusal =
  | { readonly reason: "blocked" | "grant" | "destructive" | "no-allowance" | "shared" }
  | { readonly reason: "outside"; readonly targets: ReadonlyArray<string> };

export type Consent =
  | { readonly kind: "run" }
  | { readonly kind: "ask" }
  | ({ readonly kind: "refuse" } & Refusal);

const RUN: Consent = { kind: "run" };
const ASK: Consent = { kind: "ask" };

/** Reads are allowed and anything that changes the service asks, until set otherwise. */
export const defaultPermission = (access: ToolAccess): ToolPermission =>
  access === "read" ? "allow" : "ask";

export const permissionFor = (
  tool: { name: string; access: ToolAccess },
  permissions: Readonly<Record<string, ToolPermission>>,
): ToolPermission => permissions[tool.name] ?? defaultPermission(tool.access);

/** A call that contacts people is destructive, whatever its tool declares. */
export const effectiveAccess = (access: ToolAccess, reach: Reach | null): ToolAccess =>
  reach && reach.targets.length > 0 ? "destructive" : access;

/**
 * The one decision table for integration calls. A blocked tool never runs.
 * With someone present the tool's own permission decides; "always allow in
 * this chat" lifts an ask there, except for a destructive call, which only an
 * explicit "allow" in Settings runs unasked. Unattended, the schedule's grant
 * is the ceiling and nothing waits: a call reaching people runs only when its
 * allowance lists every one of them, and any other destructive call never.
 */
export const consentFor = (input: {
  access: ToolAccess;
  permission: ToolPermission;
  allowedInChat: boolean;
  unattended: UnattendedGrant;
  reach: Reach | null;
  /** The admin's key for everyone: a change would act as the admin, so it never runs. */
  shared?: boolean;
}): Consent => {
  if (input.permission === "block") return { kind: "refuse", reason: "blocked" };
  const access = effectiveAccess(input.access, input.reach);
  if (input.shared && access !== "read") return { kind: "refuse", reason: "shared" };
  const unattended = input.unattended;
  if (unattended !== null) {
    if (access === "read") return RUN;
    if (unattended.access !== "write") return { kind: "refuse", reason: "grant" };
    if (input.reach && input.reach.targets.length > 0) {
      const listed = unattended.allowances[input.reach.allowance];
      if (!listed) return { kind: "refuse", reason: "no-allowance" };
      const outside = input.reach.targets.filter((target) => !listed.includes(target));
      return outside.length ? { kind: "refuse", reason: "outside", targets: outside } : RUN;
    }
    // Deleting is never granted ahead of time: nobody would see it happen.
    return access === "destructive" ? { kind: "refuse", reason: "destructive" } : RUN;
  }
  if (input.permission === "allow") return RUN;
  // One approval in a chat can lift asks for changes, never for destructive calls.
  if (input.allowedInChat && access !== "destructive") return RUN;
  return ASK;
};
