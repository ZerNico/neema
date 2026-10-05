import { describe, expect, it } from "vitest";
import { consentFor, permissionFor } from "./consent.ts";

const person = { allowedInChat: false, unattended: null } as const;
const run = { kind: "run" };
const ask = { kind: "ask" };
const refused = (reason: string) => ({ kind: "refuse", reason });

describe("integration consent", () => {
  it("defaults to allowing reads and asking before changes", () => {
    expect(permissionFor({ name: "search", access: "read" }, {})).toBe("allow");
    expect(permissionFor({ name: "create", access: "write" }, {})).toBe("ask");
    expect(permissionFor({ name: "delete", access: "destructive" }, {})).toBe("ask");
    expect(permissionFor({ name: "create", access: "write" }, { create: "allow" })).toBe("allow");
  });

  it("follows each tool's own permission while someone is present", () => {
    expect(consentFor({ ...person, access: "read", permission: "allow" })).toEqual(run);
    expect(consentFor({ ...person, access: "read", permission: "ask" })).toEqual(ask);
    expect(consentFor({ ...person, access: "write", permission: "allow" })).toEqual(run);
    expect(consentFor({ ...person, access: "write", permission: "block" })).toEqual(
      refused("blocked"),
    );
  });

  it("lets “always allow in this chat” lift an ask, never a block", () => {
    const here = { access: "write", allowedInChat: true, unattended: null } as const;
    expect(consentFor({ ...here, permission: "ask" })).toEqual(run);
    expect(consentFor({ ...here, permission: "block" })).toEqual(refused("blocked"));
  });

  it("keeps deleting behind an explicit choice", () => {
    // A one-off "always allow in this chat" does not cover it.
    expect(
      consentFor({
        access: "destructive",
        permission: "ask",
        allowedInChat: true,
        unattended: null,
      }),
    ).toEqual(ask);
    // Allowing it in Settings does, with someone present.
    expect(consentFor({ ...person, access: "destructive", permission: "allow" })).toEqual(run);
    // A schedule never runs it, whatever it was granted.
    expect(
      consentFor({
        access: "destructive",
        permission: "allow",
        allowedInChat: false,
        unattended: "write",
      }),
    ).toEqual(refused("destructive"));
  });

  it("never waits during a schedule fire: the grant is the ceiling", () => {
    const fire = (access: "read" | "write", unattended: "read" | "write") =>
      consentFor({ access, permission: "ask", allowedInChat: false, unattended });
    expect(fire("read", "read")).toEqual(run);
    expect(fire("write", "read")).toEqual(refused("grant"));
    expect(fire("write", "write")).toEqual(run);
    expect(
      consentFor({
        access: "read",
        permission: "block",
        allowedInChat: false,
        unattended: "write",
      }),
    ).toEqual(refused("blocked"));
  });
});
