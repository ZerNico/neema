import { describe, expect, it } from "vitest";
import { methodFromContext } from "./config.ts";

describe("the way in an account is created through", () => {
  it("is the provider on an OAuth return, built-in or generic", () => {
    expect(methodFromContext({ path: "/callback/:id", params: { id: "google" } })).toBe("google");
  });

  it("is the provider when an ID token signs up within the sign-in call", () => {
    expect(methodFromContext({ path: "/sign-in/social", body: { provider: "google" } })).toBe(
      "google",
    );
  });

  it("is password only for email registration", () => {
    expect(methodFromContext({ path: "/sign-up/email" })).toBeNull();
  });

  it("is unknown anywhere else, which admits nobody new", () => {
    expect(methodFromContext({ path: "/admin/create-user", body: {} })).toBeUndefined();
    expect(methodFromContext(null)).toBeUndefined();
  });
});
