import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Config, Context, Effect, Layer, Redacted } from "effect";

/**
 * AES-256-GCM encryption for provider API keys at rest.
 * Format: base64(iv).base64(tag).base64(ciphertext)
 */
export class KeyCipher extends Context.Service<
  KeyCipher,
  {
    encrypt(plaintext: string): Effect.Effect<string>;
    decrypt(ciphertext: string): Effect.Effect<Redacted.Redacted<string>>;
  }
>()("chat/providers/KeyCipher") {
  static readonly layer = Layer.effect(
    KeyCipher,
    Effect.gen(function* () {
      const secret = yield* Config.Redacted("PROVIDER_KEY_SECRET").pipe(Effect.orDie);
      const key = Buffer.from(Redacted.value(secret), "base64");

      const encrypt = (plaintext: string) =>
        Effect.sync(() => {
          const iv = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", key, iv);
          const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
          return [
            iv.toString("base64"),
            cipher.getAuthTag().toString("base64"),
            enc.toString("base64"),
          ].join(".");
        });

      const decrypt = (ciphertext: string) =>
        Effect.sync(() => {
          const [ivB64, tagB64, dataB64] = ciphertext.split(".");
          const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64!, "base64"));
          decipher.setAuthTag(Buffer.from(tagB64!, "base64"));
          const dec = Buffer.concat([
            decipher.update(Buffer.from(dataB64!, "base64")),
            decipher.final(),
          ]);
          return Redacted.make(dec.toString("utf8"));
        });

      return KeyCipher.of({ encrypt, decrypt });
    }),
  );
}
