import { describe, expect, it } from "vitest";
import { parseMailbox } from "./mailbox.ts";

describe("parseMailbox", () => {
  it("writes a bare address one way", () => {
    expect(parseMailbox(" Ana.Lopez@Example.COM ")).toBe("ana.lopez@example.com");
    expect(parseMailbox("ops+alerts@sub.example.co.uk")).toBe("ops+alerts@sub.example.co.uk");
    // The domain in ASCII, so a grant and a payload compare equal however typed.
    expect(parseMailbox("info@bücher.de")).toBe("info@xn--bcher-kva.de");
    expect(parseMailbox("info@xn--bcher-kva.de")).toBe("info@xn--bcher-kva.de");
  });

  it.each([
    "Ana <ana@example.com>",
    "ana@example.com, bo@example.com",
    '"ana"@example.com',
    "ana@@example.com",
    "ana@example",
    "ana@example.com:25",
    "ana@example.com/x",
    "ana@1.2.3.4",
    "ana@[127.0.0.1]",
    "ana@exa mple.com",
    "ana@-example.com",
    ".ana@example.com",
    "an..a@example.com",
    "@example.com",
    "ana",
    "",
  ])("refuses %j", (raw) => {
    expect(parseMailbox(raw)).toBeNull();
  });
});
