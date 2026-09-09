import { Effect, Layer } from "effect";
import { MemoryService } from "~/modules/memory/server/service.ts";

const baseSettings = {
  referenceEnabled: true,
  autoSaveEnabled: true,
  globalEnabled: false,
  effectiveReferenceEnabled: false,
  effectiveAutoSaveEnabled: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

// Inert by default; enable auto-save to test tool availability without persisting memories.
export const makeFakeMemoryService = (options: { autoSave?: boolean } = {}) => {
  const settings = options.autoSave
    ? { ...baseSettings, globalEnabled: true, effectiveAutoSaveEnabled: true }
    : baseSettings;
  return Layer.succeed(MemoryService, {
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
};

export const FakeMemoryService = makeFakeMemoryService();
