import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base64url,
  encryptPushPayload,
  fromBase64url,
  generateVapidKeys,
  vapidAuthorization,
} from "./web-push.ts";

describe("web push", () => {
  // RFC 8291, Appendix A.
  it("encrypts the RFC's example to the RFC's bytes", () => {
    const body = encryptPushPayload({
      plaintext: fromBase64url("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
      receiverPublicKey: fromBase64url(
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      ),
      authSecret: fromBase64url("BTBZMqHH6r4Tts7J_aSIgg"),
      salt: fromBase64url("DGv6ra1nlYgDCS1FRnbzlw"),
      senderPrivateKey: fromBase64url("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
    });
    expect(base64url(body)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
        "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
        "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("signs a token for the endpoint's origin that the public key verifies", () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization({
      endpoint: new URL("https://push.example.test/send/abc"),
      keys,
      subject: "https://chat.example.test",
      now: new Date("2026-10-08T12:00:00Z"),
    });
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    const [, head, claims, signature, k] = match;
    expect(k).toBe(base64url(keys.publicKey));
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
      aud: "https://push.example.test",
      exp: Date.parse("2026-10-08T12:00:00Z") / 1000 + 43200,
      sub: "https://chat.example.test",
    });
    const publicKey = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: base64url(keys.publicKey.slice(1, 33)),
        y: base64url(keys.publicKey.slice(33)),
      },
      format: "jwk",
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${head}.${claims}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
  });
});
