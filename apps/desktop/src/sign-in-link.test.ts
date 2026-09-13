import { describe, expect, it } from "vitest";
import { ticketFromArgv, ticketFromDeepLink, userAgentToken } from "./sign-in-link.ts";

describe("ticketFromDeepLink", () => {
  it("reads the ticket from the sign-in link", () => {
    expect(ticketFromDeepLink("chat-desktop://sign-in?ticket=K7MX-4QPD")).toBe("K7MX-4QPD");
    expect(ticketFromDeepLink("chat-desktop://sign-in/?ticket=abc&x=1")).toBe("abc");
    expect(ticketFromDeepLink("chat-desktop:sign-in?ticket=abc")).toBe("abc");
  });

  it.each([
    "https://example.com/sign-in?ticket=abc",
    "chat-desktop://open?ticket=abc",
    "chat-desktop://sign-in/extra?ticket=abc",
    "chat-desktop://sign-in",
    "chat-desktop://sign-in?ticket=",
    "chat-desktop://sign-in?ticket=%20",
    "not a url",
    "",
  ])("rejects %j", (url) => {
    expect(ticketFromDeepLink(url)).toBeNull();
  });
});

describe("ticketFromArgv", () => {
  it("finds the link among ordinary arguments", () => {
    expect(
      ticketFromArgv(["electron", "dist/main.cjs", "--flag", "chat-desktop://sign-in?ticket=T1"]),
    ).toBe("T1");
  });

  it("finds nothing when no argument is a sign-in link", () => {
    expect(ticketFromArgv(["electron", "dist/main.cjs", "https://x.test?ticket=T1"])).toBeNull();
    expect(ticketFromArgv([])).toBeNull();
  });
});

describe("userAgentToken", () => {
  it("keeps only the sha from the build stamp", () => {
    expect(userAgentToken("d41e97a 2026-09-13 10:00")).toBe("ChatDesktop/d41e97a");
    expect(userAgentToken("")).toBe("ChatDesktop/unknown");
  });
});
