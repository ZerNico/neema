import { Effect, Layer } from "effect";
import { MemoryService } from "~/modules/memory/server/service.ts";

const settings = {
  referenceEnabled: true,
  autoSaveEnabled: true,
  globalEnabled: false,
  effectiveReferenceEnabled: false,
  effectiveAutoSaveEnabled: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

// Most integration suites exercise chat behavior unrelated to memory. Keep the
// new StreamEngine dependency inert there; memory has its own repository tests.
export const FakeMemoryService = Layer.succeed(MemoryService, {
  getSettings: () => Effect.succeed(settings),
  updateSettings: (_userId, input) =>
    Effect.succeed({
      referenceEnabled: input.referenceEnabled ?? settings.referenceEnabled,
      autoSaveEnabled: input.autoSaveEnabled ?? settings.autoSaveEnabled,
      globalEnabled: false,
      effectiveReferenceEnabled: false,
      effectiveAutoSaveEnabled: false,
      updatedAt: settings.updatedAt,
    }),
  list: () => Effect.succeed([]),
  listReferenceable: () => Effect.succeed([]),
  createManual: () => Effect.succeed({ outcome: "rejected", reason: "empty" }),
  updateManual: () => Effect.succeed({ outcome: "not_found" }),
  delete: () => Effect.succeed({ outcome: "not_found" }),
  clear: () => Effect.succeed(0),
  saveModel: () => Effect.succeed({ outcome: "disabled" }),
});
