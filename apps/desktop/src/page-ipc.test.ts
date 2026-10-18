import { describe, expect, it, vi } from "vitest";
import { AgentChoicePayload, NetworkGrant, NoPayload } from "@chat/desktop-rpc";
import { pageHandler } from "./page-ipc.ts";

const page = { fromPage: true };
const elsewhere = { fromPage: false };
const allowed = (event: { fromPage: boolean }) => event.fromPage;

describe("pageHandler", () => {
  it("refuses another sender before decoding or running", () => {
    const run = vi.fn();
    const handle = pageHandler(allowed, NoPayload, run);
    expect(() => handle(elsewhere)).toThrow("Not allowed from this page.");
    expect(run).not.toHaveBeenCalled();
  });

  it("hands run the decoded payload", () => {
    const handle = pageHandler(allowed, NetworkGrant, (grant) => grant);
    const grant = { host: "github.com", port: 22, privateNetwork: false };
    expect(handle(page, grant)).toEqual(grant);
    expect(pageHandler(allowed, NoPayload, () => "ran")(page)).toBe("ran");
    expect(
      pageHandler(allowed, AgentChoicePayload, ({ socket }) => socket)(page, { socket: null }),
    ).toBeNull();
  });

  it("refuses a payload outside the schema with the channel's message", () => {
    const run = vi.fn();
    const handle = pageHandler(allowed, NetworkGrant, run, "Invalid network permission.");
    for (const payload of [
      undefined,
      "github.com",
      { host: "github.com", port: "22", privateNetwork: false },
      { host: "github.com", port: 0, privateNetwork: false },
      { host: "github.com", port: 22 },
    ])
      expect(() => handle(page, payload)).toThrow("Invalid network permission.");
    expect(() => pageHandler(allowed, AgentChoicePayload, run)(page, {})).toThrow(
      "Malformed request.",
    );
    expect(() => pageHandler(allowed, NoPayload, run)(page, { extra: true })).toThrow(
      "Malformed request.",
    );
    expect(run).not.toHaveBeenCalled();
  });
});
