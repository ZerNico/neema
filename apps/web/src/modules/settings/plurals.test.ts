import { describe, expect, it } from "vitest";
import { m } from "~/paraglide/messages.js";
import { describeSession } from "./ui/describe-session.ts";

describe("settings counts", () => {
  it("reads one and many in each language", () => {
    expect(m.settings_archived_count({ count: 1 }, { locale: "en" })).toBe("1 chat");
    expect(m.settings_archived_count({ count: 3 }, { locale: "en" })).toBe("3 chats");
    expect(m.settings_archived_count({ count: 1 }, { locale: "de" })).toBe("1 Chat");
    expect(m.settings_archived_count({ count: 3 }, { locale: "de" })).toBe("3 Chats");
    expect(m.settings_ssh_key_count({ count: 2 }, { locale: "de" })).toBe("2 Schlüssel");
    expect(m.settings_api_keys_lifetime_days({ count: 30 }, { locale: "de" })).toBe("30 Tage");
  });

  it("keeps the place first however many more there are", () => {
    expect(
      m.settings_storage_where_more({ place: "Not sent yet", count: 1 }, { locale: "en" }),
    ).toBe("Not sent yet and 1 more place");
    expect(
      m.settings_storage_where_more({ place: "Noch nicht gesendet", count: 2 }, { locale: "de" }),
    ).toBe("Noch nicht gesendet und 2 weitere Orte");
  });
});

describe("describeSession", () => {
  it("names the browser and system", () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Firefox/130.0";
    expect(describeSession(ua, false)).toBe("Firefox on macOS");
    expect(describeSession(ua, true)).toBe("neema Desktop on macOS");
  });
});
