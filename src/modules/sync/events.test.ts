import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { SyncEvent, UserSyncEnvelope } from "./events.ts";

const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(UserSyncEnvelope));
const encodeEnvelope = Schema.encodeEffect(Schema.fromJsonString(UserSyncEnvelope));

describe("sync events", () => {
  it.effect("roundtrips an envelope through its JSON wire format", () =>
    Effect.gen(function* () {
      const event: SyncEvent = {
        type: "message.status",
        conversationId: "c1",
        messageId: "m1",
        status: "complete",
      };
      const wire = yield* encodeEnvelope({ userId: "u1", event });
      expect(typeof wire).toBe("string");
      const decoded = yield* decodeEnvelope(wire);
      expect(decoded).toEqual({ userId: "u1", event });
    }),
  );

  it.effect("rejects unknown event types", () =>
    Effect.gen(function* () {
      const result = yield* decodeEnvelope(
        JSON.stringify({ userId: "u1", event: { type: "nope" } }),
      ).pipe(Effect.flip);
      expect(result._tag).toBe("SchemaError");
    }),
  );
});
