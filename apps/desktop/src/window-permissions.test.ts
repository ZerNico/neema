import { describe, expect, it } from "vitest";
import { allowAppPermission } from "./window-permissions.ts";

const server = "https://chat.example.com";

describe("app window permissions", () => {
  it("allows what the app uses, to the configured server alone", () => {
    for (const permission of ["notifications", "clipboard-read", "clipboard-sanitized-write"])
      expect(allowAppPermission(permission, `${server}/chats/1`, server)).toBe(true);
    expect(allowAppPermission("notifications", "https://evil.example/", server)).toBe(false);
    expect(allowAppPermission("notifications", `${server}/`, null)).toBe(false);
  });

  it("refuses devices and everything else, even to the server", () => {
    for (const permission of ["media", "geolocation", "hid", "serial", "usb", "midiSysex"])
      expect(allowAppPermission(permission, `${server}/`, server)).toBe(false);
  });
});
