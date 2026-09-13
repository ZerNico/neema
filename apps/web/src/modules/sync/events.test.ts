import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { SyncEnvelope, SyncEvent } from "./events.ts";

const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(SyncEnvelope));
const encodeEnvelope = Schema.encodeEffect(Schema.fromJsonString(SyncEnvelope));

describe("sync events", () => {
  it.effect("roundtrips an envelope through its JSON wire format", () =>
    Effect.gen(function* () {
      const event: SyncEvent = {
        type: "message.status",
        conversationId: "c1",
        messageId: "m1",
        status: "complete",
      };
      const wire = yield* encodeEnvelope({ scope: "user", userId: "u1", event });
      expect(typeof wire).toBe("string");
      const decoded = yield* decodeEnvelope(wire);
      expect(decoded).toEqual({ scope: "user", userId: "u1", event });
    }),
  );

  it.effect("roundtrips memory invalidations", () =>
    Effect.gen(function* () {
      const wire = yield* encodeEnvelope({
        scope: "user",
        userId: "u1",
        event: { type: "memory.changed" },
      });
      expect(yield* decodeEnvelope(wire)).toEqual({
        scope: "user",
        userId: "u1",
        event: { type: "memory.changed" },
      });
    }),
  );

  it.effect("roundtrips global memory policy invalidations", () =>
    Effect.gen(function* () {
      const wire = yield* encodeEnvelope({
        scope: "global",
        event: { type: "memory.policy.changed" },
      });
      expect(yield* decodeEnvelope(wire)).toEqual({
        scope: "global",
        event: { type: "memory.policy.changed" },
      });
    }),
  );

  it.effect("roundtrips model default invalidations without model data", () =>
    Effect.gen(function* () {
      const envelope = {
        scope: "global" as const,
        event: { type: "models.defaults.changed" as const },
      };
      expect(yield* decodeEnvelope(yield* encodeEnvelope(envelope))).toEqual(envelope);
    }),
  );

  it.effect("roundtrips global resource invalidation without resource metadata", () =>
    Effect.gen(function* () {
      const envelope = { scope: "global" as const, event: { type: "resources.changed" as const } };
      expect(yield* decodeEnvelope(yield* encodeEnvelope(envelope))).toEqual(envelope);
    }),
  );

  it.effect("roundtrips content-free knowledge indexing invalidations", () =>
    Effect.gen(function* () {
      const envelope = {
        scope: "global" as const,
        event: { type: "knowledge.index.changed" as const },
      };
      expect(yield* decodeEnvelope(yield* encodeEnvelope(envelope))).toEqual(envelope);
    }),
  );

  it.effect("roundtrips desktop session creation with the ticket handle only", () =>
    Effect.gen(function* () {
      const envelope = {
        scope: "user" as const,
        userId: "u1",
        event: { type: "desktop.session.created" as const, ticketId: "t1" },
      };
      expect(yield* decodeEnvelope(yield* encodeEnvelope(envelope))).toEqual(envelope);
    }),
  );

  it.effect("rejects unknown event types", () =>
    Effect.gen(function* () {
      const result = yield* decodeEnvelope(
        JSON.stringify({ scope: "user", userId: "u1", event: { type: "nope" } }),
      ).pipe(Effect.flip);
      expect(result._tag).toBe("SchemaError");
    }),
  );
});
