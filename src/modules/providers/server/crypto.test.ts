import { expect, it, layer } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { KeyCipher } from "./crypto.ts";

// KeyCipher reads PROVIDER_KEY_SECRET from the environment.
process.env.PROVIDER_KEY_SECRET = Buffer.alloc(32, 7).toString("base64");

layer(KeyCipher.layer)("KeyCipher", (it) => {
  it.effect("roundtrips a secret", () =>
    Effect.gen(function* () {
      const cipher = yield* KeyCipher;
      const ciphertext = yield* cipher.encrypt("sk-super-secret");
      expect(ciphertext).not.toContain("sk-super-secret");
      const decrypted = yield* cipher.decrypt(ciphertext);
      expect(Redacted.value(decrypted)).toBe("sk-super-secret");
    }),
  );

  it.effect("produces distinct ciphertexts per call (fresh IV)", () =>
    Effect.gen(function* () {
      const cipher = yield* KeyCipher;
      const a = yield* cipher.encrypt("same-input");
      const b = yield* cipher.encrypt("same-input");
      expect(a).not.toBe(b);
    }),
  );
});
