import { describe, expect, it } from "vitest";
import { consentFor, permissionFor } from "./consent.ts";

const person = { allowedInChat: false, unattended: null } as const;

describe("integration consent", () => {
  it("defaults to allowing reads and asking before changes", () => {
    expect(permissionFor({ name: "search", access: "read" }, {})).toBe("allow");
    expect(permissionFor({ name: "create", access: "write" }, {})).toBe("ask");
    expect(permissionFor({ name: "delete", access: "destructive" }, {})).toBe("ask");
    expect(permissionFor({ name: "create", access: "write" }, { create: "allow" })).toBe("allow");
  });

  it("follows each tool's own permission while someone is present", () => {
    expect(consentFor({ ...person, access: "read", permission: "allow" })).toBe("run");
    expect(consentFor({ ...person, access: "read", permission: "ask" })).toBe("ask");
    expect(consentFor({ ...person, access: "write", permission: "allow" })).toBe("run");
    expect(consentFor({ ...person, access: "write", permission: "block" })).toBe("refuse");
  });

  it("lets “always allow in this chat” lift an ask, never a block", () => {
    const here = { access: "write", allowedInChat: true, unattended: null } as const;
    expect(consentFor({ ...here, permission: "ask" })).toBe("run");
    expect(consentFor({ ...here, permission: "block" })).toBe("refuse");
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
    ).toBe("ask");
    // Allowing it in Settings does, with someone present.
    expect(consentFor({ ...person, access: "destructive", permission: "allow" })).toBe("run");
    // A schedule never runs it, whatever it was granted.
    expect(
      consentFor({
        access: "destructive",
        permission: "allow",
        allowedInChat: false,
        unattended: "write",
      }),
    ).toBe("refuse");
  });

  it("never waits during a schedule fire: the grant is the ceiling", () => {
    const fire = (access: "read" | "write", unattended: "read" | "write") =>
      consentFor({ access, permission: "ask", allowedInChat: false, unattended });
    expect(fire("read", "read")).toBe("run");
    expect(fire("write", "read")).toBe("refuse");
    expect(fire("write", "write")).toBe("run");
    expect(
      consentFor({
        access: "read",
        permission: "block",
        allowedInChat: false,
        unattended: "write",
      }),
    ).toBe("refuse");
  });
});
