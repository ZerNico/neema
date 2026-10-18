import { describe, expect, it } from "vitest";
import { authorizeQuery, needsFreshSignIn, packQuery, unpackQuery } from "./authorize-query.ts";

const signed =
  "response_type=code&client_id=c&state=0012.50&scope=chats%3Aread+offline_access" +
  "&prompt=login+consent&max_age=0&exp=1&ba_iat=2&ba_param=client_id&ba_param=state&sig=a%2Bb%3D";

describe("authorizeQuery", () => {
  it("keeps the app's own request and drops what signing and sign-in added", () => {
    const params = new URLSearchParams(authorizeQuery(`?${signed}`));
    expect([...params.keys()]).toEqual(["response_type", "client_id", "state", "scope", "prompt"]);
    expect(params.get("state")).toBe("0012.50");
    expect(params.get("prompt")).toBe("consent");
  });

  it("drops a prompt that only asked for sign-in", () => {
    expect(new URLSearchParams(authorizeQuery("client_id=c&prompt=login")).has("prompt")).toBe(
      false,
    );
  });
});

describe("packQuery", () => {
  it("round-trips repeated keys and numeric-looking values exactly", () => {
    const packed = packQuery(signed);
    expect(packed).toMatch(/^[\w-]+$/);
    expect(unpackQuery(packed)).toBe(signed);
  });

  it("round-trips non-ASCII text", () => {
    expect(unpackQuery(packQuery("state=über%20ß"))).toBe("state=über%20ß");
  });

  it("refuses anything that is not one packed value", () => {
    expect(unpackQuery(undefined)).toBeNull();
    expect(unpackQuery("a b")).toBeNull();
    expect(unpackQuery(["x"])).toBeNull();
  });
});

describe("needsFreshSignIn", () => {
  it("is set by a login prompt or a maximum age", () => {
    expect(needsFreshSignIn("?client_id=c&prompt=login")).toBe(true);
    expect(needsFreshSignIn("client_id=c&prompt=consent+login")).toBe(true);
    expect(needsFreshSignIn("client_id=c&max_age=300")).toBe(true);
  });

  it("is not set by an ordinary request", () => {
    expect(needsFreshSignIn("client_id=c&prompt=consent")).toBe(false);
    expect(needsFreshSignIn("client_id=c")).toBe(false);
  });
});
