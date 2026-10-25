import { afterEach, describe, expect, it } from "vitest";
import { baseLocale, overwriteGetLocale } from "~/paraglide/runtime.js";
import { IMPERSONATING, oauthErrorMessage, SIGNUP_CLOSED } from "./oauth-errors.ts";

afterEach(() => overwriteGetLocale(() => baseLocale));

describe("a failed OAuth round trip", () => {
  it("is explained in the reader's language", () => {
    expect(oauthErrorMessage(SIGNUP_CLOSED)).toBe("This sign-in can’t create new accounts here.");
    overwriteGetLocale(() => "de");
    expect(oauthErrorMessage(SIGNUP_CLOSED)).toBe(
      "Mit dieser Anmeldung lassen sich hier keine neuen Konten erstellen.",
    );
    expect(oauthErrorMessage(IMPERSONATING)).toMatch(/^Beende zuerst/);
  });

  it("falls back to a general line for a code it does not know, prototype names included", () => {
    expect(oauthErrorMessage("constructor")).toBe("Sign-in didn’t complete. Try again.");
  });
});
