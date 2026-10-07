import { expect, it, layer } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Layer, Redacted } from "effect";
import { KeyCipher } from "./crypto.ts";

// KeyCipher reads ENCRYPTION_KEY from the environment.
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

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

it.effect("refuses a key that isn't 32 bytes", () =>
  Effect.gen(function* () {
    const config = ConfigProvider.layer(
      ConfigProvider.fromUnknown({ ENCRYPTION_KEY: Buffer.alloc(16, 7).toString("base64") }),
    );
    const exit = yield* Effect.exit(
      Layer.build(KeyCipher.layer.pipe(Layer.provide(config))).pipe(Effect.scoped),
    );
    expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain("must be 32 bytes");
  }),
);
