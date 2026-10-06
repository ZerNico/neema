import { describe, expect, it } from "vitest";
import { consentFor, permissionFor } from "./consent.ts";

const person = { allowedInChat: false, unattended: null, reach: null } as const;
const run = { kind: "run" };
const ask = { kind: "ask" };
const refused = (reason: string) => ({ kind: "refuse", reason });
const granted = (access: "read" | "write", allowances = {}) => ({ access, allowances });

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
    const here = { access: "write", allowedInChat: true, unattended: null, reach: null } as const;
    expect(consentFor({ ...here, permission: "ask" })).toEqual(run);
    expect(consentFor({ ...here, permission: "block" })).toEqual(refused("blocked"));
  });

  it("keeps deleting behind an explicit choice", () => {
    // A one-off "always allow in this chat" does not cover it.
    expect(
      consentFor({ ...person, access: "destructive", permission: "ask", allowedInChat: true }),
    ).toEqual(ask);
    // Allowing it in Settings does, with someone present.
    expect(consentFor({ ...person, access: "destructive", permission: "allow" })).toEqual(run);
    // A schedule never runs it, whatever it was granted.
    expect(
      consentFor({
        ...person,
        access: "destructive",
        permission: "allow",
        unattended: granted("write"),
      }),
    ).toEqual(refused("destructive"));
  });

  it("never waits during a schedule fire: the grant is the ceiling", () => {
    const fire = (access: "read" | "write", unattended: "read" | "write") =>
      consentFor({ ...person, access, permission: "ask", unattended: granted(unattended) });
    expect(fire("read", "read")).toEqual(run);
    expect(fire("write", "read")).toEqual(refused("grant"));
    expect(fire("write", "write")).toEqual(run);
    expect(
      consentFor({ ...person, access: "read", permission: "block", unattended: granted("write") }),
    ).toEqual(refused("blocked"));
  });

  describe("calls that reach people", () => {
    const invite = { allowance: "invite", targets: ["ana@example.com"] };

    it("treats them as destructive with someone present", () => {
      // A plain write the chat allowed still asks once it would invite someone.
      expect(
        consentFor({ ...person, access: "write", permission: "ask", allowedInChat: true }),
      ).toEqual(run);
      expect(
        consentFor({
          ...person,
          access: "write",
          permission: "ask",
          allowedInChat: true,
          reach: invite,
        }),
      ).toEqual(ask);
      expect(
        consentFor({ ...person, access: "write", permission: "allow", reach: invite }),
      ).toEqual(run);
      // An empty reach contacts nobody: the tool's own access applies.
      expect(
        consentFor({
          ...person,
          access: "write",
          permission: "ask",
          allowedInChat: true,
          reach: { allowance: "invite", targets: [] },
        }),
      ).toEqual(run);
    });

    it("runs unattended only for targets the allowance lists", () => {
      const fire = (unattended: ReturnType<typeof granted>, targets: string[]) =>
        consentFor({
          ...person,
          access: "write",
          permission: "allow",
          unattended,
          reach: { allowance: "invite", targets },
        });
      const listed = granted("write", { invite: ["ana@example.com", "bo@example.com"] });
      expect(fire(listed, ["ana@example.com"])).toEqual(run);
      expect(fire(listed, ["ana@example.com", "bo@example.com"])).toEqual(run);
      expect(fire(listed, ["ana@example.com", "cy@example.com"])).toEqual({
        kind: "refuse",
        reason: "outside",
        targets: ["cy@example.com"],
      });
      // Another allowance's list does not count.
      expect(fire(granted("write", { send: ["ana@example.com"] }), ["ana@example.com"])).toEqual(
        refused("no-allowance"),
      );
      // Read access grants no allowance, whatever was listed.
      expect(fire(granted("read", { invite: ["ana@example.com"] }), ["ana@example.com"])).toEqual(
        refused("grant"),
      );
    });

    it("still lets a block win", () => {
      expect(
        consentFor({
          ...person,
          access: "write",
          permission: "block",
          unattended: granted("write", { invite: ["ana@example.com"] }),
          reach: invite,
        }),
      ).toEqual(refused("blocked"));
    });
  });
});
