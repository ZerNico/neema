import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatLocale } from "~/i18n/formats.ts";
import { noteBrowserLanguage } from "../server/functions.ts";
import { alignLanguage } from "./language.ts";

vi.mock("../server/functions.ts", () => ({
  getLanguage: vi.fn(),
  chooseLanguage: vi.fn(),
  chooseRegion: vi.fn(),
  noteBrowserLanguage: vi.fn().mockResolvedValue(undefined),
}));

const reload = vi.fn();
vi.stubGlobal("location", { ...location, reload });

const accountChose = (chosen: "en" | "de" | null, region: string | null = null) => {
  const client = new QueryClient();
  client.setQueryData(["language"], { chosen, region });
  return client;
};

afterEach(() => {
  document.cookie = "language=; path=/; max-age=0";
  document.cookie = "formats=; path=/; max-age=0";
  vi.clearAllMocks();
});

describe("alignLanguage", () => {
  it("reloads once in the language the account chose on another device", async () => {
    void alignLanguage(accountChose("de"));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(document.cookie).toContain("language=de");
  });

  it("forgets a choice cleared elsewhere, and stays when the browser already agrees", async () => {
    document.cookie = "language=en; path=/";
    await alignLanguage(accountChose(null));
    expect(document.cookie).not.toContain("language=");
    expect(reload).not.toHaveBeenCalled();
    // Following the browser: what it asked for is kept for mail sent later.
    expect(noteBrowserLanguage).toHaveBeenCalledWith({ data: { browser: "en" } });
  });

  it("writes the region in effect, picked or detected, without reloading", async () => {
    await alignLanguage(accountChose(null, "CH"));
    expect(document.cookie).toContain("formats=CH");
    expect(formatLocale()).toBe("en-CH");
    // jsdom's browser asks for en-US.
    await alignLanguage(accountChose(null));
    expect(document.cookie).toContain("formats=US");
    expect(formatLocale()).toBe("en-US");
    expect(reload).not.toHaveBeenCalled();
  });
});
