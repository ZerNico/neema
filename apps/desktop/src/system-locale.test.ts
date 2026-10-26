import { describe, expect, it } from "vitest";
import { SYSTEM_LOCALE_ARGUMENT, systemLocaleFromArgv } from "./system-locale.ts";

describe("systemLocaleFromArgv", () => {
  it("reads the tag main passed", () => {
    expect(systemLocaleFromArgv(["electron", `${SYSTEM_LOCALE_ARGUMENT}=en-DE`])).toBe("en-DE");
  });

  it("ignores a missing or malformed tag", () => {
    expect(systemLocaleFromArgv(["electron"])).toBeUndefined();
    expect(systemLocaleFromArgv([`${SYSTEM_LOCALE_ARGUMENT}=en DE;x`])).toBeUndefined();
    expect(systemLocaleFromArgv([`${SYSTEM_LOCALE_ARGUMENT}=`])).toBeUndefined();
  });
});
