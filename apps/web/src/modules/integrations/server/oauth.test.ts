import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestTokens } from "./oauth.ts";

/** What the token endpoint answers next: a status and a JSON body. */
let answer: { status: number; body: unknown } = { status: 200, body: {} };
let server: Server;
let endpoint = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on("end", () =>
      response
        .writeHead(answer.status, { "content-type": "application/json" })
        .end(JSON.stringify(answer.body)),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const exchange = (status: number, body: unknown) => {
  answer = { status, body };
  return Effect.runPromise(
    requestTokens({
      endpoint,
      clientId: "client",
      clientSecret: null,
      params: { grant_type: "refresh_token", refresh_token: "r" },
    }),
  );
};

describe("requestTokens", () => {
  it.each([
    ["a dead grant", 400, { error: "invalid_grant" }],
    ["an unknown client", 401, { error: "invalid_client" }],
    ["a client no longer allowed", 400, { error: "unauthorized_client" }],
    ["a bare 401", 401, {}],
    [
      "Outline's spent refresh token",
      400,
      { error: "invalid_request", error_description: "Invalid grant: refresh token is invalid" },
    ],
  ])("reads %s as revoked, so the person reconnects", async (_name, status, body) => {
    expect(await exchange(status, body)).toEqual({ ok: false, revoked: true });
  });

  it.each([
    ["a server error naming an error", 500, { error: "server_error" }],
    ["an outage", 503, { error: "temporarily_unavailable" }],
    ["a malformed request", 400, { error: "invalid_request", error_description: "Missing scope" }],
    ["a success without a token", 200, { token_type: "bearer" }],
  ])("reads %s as transient, keeping the connection", async (_name, status, body) => {
    expect(await exchange(status, body)).toEqual({ ok: false, revoked: false });
  });

  it("returns the tokens and their expiry", async () => {
    const before = Date.now();
    const outcome = await exchange(200, {
      access_token: "a",
      refresh_token: "r2",
      expires_in: 60,
    });
    expect(outcome).toMatchObject({ ok: true, tokens: { accessToken: "a", refreshToken: "r2" } });
    const expiresAt = outcome.ok ? outcome.tokens.expiresAt : null;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60_000);
  });
});
