import { describe, expect, it } from "vitest";
import { methodFromContext, signsInThrough } from "./config.ts";

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

describe("a sign-in for an account bound to an exclusive provider", () => {
  const sso = [{ id: "sso" }];

  it("passes through that provider, by redirect or ID token", () => {
    expect(signsInThrough({ path: "/callback/:id", params: { id: "sso" } }, sso)).toBe(true);
    expect(signsInThrough({ path: "/sign-in/social", body: { provider: "sso" } }, sso)).toBe(true);
  });

  it("is refused through any other way in", () => {
    expect(signsInThrough({ path: "/callback/:id", params: { id: "github" } }, sso)).toBe(false);
    expect(signsInThrough({ path: "/sign-in/email" }, sso)).toBe(false);
    expect(signsInThrough({ path: "/verify-email" }, sso)).toBe(false);
  });

  it("leaves an unbound account free to use any", () => {
    expect(signsInThrough({ path: "/sign-in/email" }, [])).toBe(true);
  });
});
