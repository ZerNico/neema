import { Schema } from "effect";

export const MAX_MEMORIES_PER_USER = 50;
export const MAX_MEMORY_CONTENT_LENGTH = 500;

export const MemoryOrigin = Schema.Literals(["manual", "model"]);
export type MemoryOrigin = typeof MemoryOrigin.Type;

export const MemoryPreferences = Schema.Struct({
  referenceEnabled: Schema.Boolean,
  autoSaveEnabled: Schema.Boolean,
  pastChatsEnabled: Schema.Boolean,
  updatedAt: Schema.String,
});
export type MemoryPreferences = typeof MemoryPreferences.Type;

/**
 * Raw user preferences stay visible even when the instance-wide memory tool is
 * disabled. The effective fields are what generation code must act on.
 */
export const MemorySettings = Schema.Struct({
  ...MemoryPreferences.fields,
  globalEnabled: Schema.Boolean,
  effectiveReferenceEnabled: Schema.Boolean,
  effectiveAutoSaveEnabled: Schema.Boolean,
  effectivePastChatsEnabled: Schema.Boolean,
});
export type MemorySettings = typeof MemorySettings.Type;

export const Memory = Schema.Struct({
  id: Schema.String,
  content: Schema.String,
  origin: MemoryOrigin,
  editedAt: Schema.NullOr(Schema.String),
  sourceConversationId: Schema.NullOr(Schema.String),
  sourceConversationTitle: Schema.NullOr(Schema.String),
  sourceMessageId: Schema.NullOr(Schema.String),
  sourceMessageEdited: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Memory = typeof Memory.Type;

/**
 * Mutation inputs leave content-length checks to the service so callers receive
 * a typed rejection instead of a transport-level schema error.
 */
export const CreateMemoryInput = Schema.Struct({
  content: Schema.String,
});
export type CreateMemoryInput = typeof CreateMemoryInput.Type;

export const UpdateMemoryInput = Schema.Struct({
  memoryId: Schema.String,
  content: Schema.String,
});
export type UpdateMemoryInput = typeof UpdateMemoryInput.Type;

export const DeleteMemoryInput = Schema.Struct({
  memoryId: Schema.String,
});
export type DeleteMemoryInput = typeof DeleteMemoryInput.Type;

export const UpdateMemorySettingsInput = Schema.Struct({
  referenceEnabled: Schema.optionalKey(Schema.Boolean),
  autoSaveEnabled: Schema.optionalKey(Schema.Boolean),
  pastChatsEnabled: Schema.optionalKey(Schema.Boolean),
});
export type UpdateMemorySettingsInput = typeof UpdateMemorySettingsInput.Type;

/**
 * Internal trusted input captured with the generation's message snapshot. It is
 * deliberately not exposed by a server function: the current source is hashed
 * again under the write lock and must still match this value.
 */
export const SaveModelMemoryInput = Schema.Struct({
  memoryId: Schema.optionalKey(Schema.String),
  content: Schema.String,
  sourceConversationId: Schema.String,
  sourceMessageId: Schema.String,
  sourceMessageHash: Schema.String,
});
export type SaveModelMemoryInput = typeof SaveModelMemoryInput.Type;

export const MemoryRejectionReason = Schema.Literals(["empty", "too_long", "sensitive"]);
export type MemoryRejectionReason = typeof MemoryRejectionReason.Type;

const CreatedMemoryOutcome = Schema.Struct({
  outcome: Schema.Literals(["created"]),
  memory: Memory,
});
const UpdatedMemoryOutcome = Schema.Struct({
  outcome: Schema.Literals(["updated"]),
  memory: Memory,
});
const DuplicateMemoryOutcome = Schema.Struct({
  outcome: Schema.Literals(["duplicate"]),
  memory: Memory,
});
const RejectedMemoryOutcome = Schema.Struct({
  outcome: Schema.Literals(["rejected"]),
  reason: MemoryRejectionReason,
});

export const MemoryWriteOutcome = Schema.Union([
  CreatedMemoryOutcome,
  UpdatedMemoryOutcome,
  DuplicateMemoryOutcome,
  RejectedMemoryOutcome,
  Schema.Struct({ outcome: Schema.Literals(["limit_reached"]) }),
  Schema.Struct({ outcome: Schema.Literals(["not_found"]) }),
  Schema.Struct({ outcome: Schema.Literals(["protected"]) }),
  Schema.Struct({ outcome: Schema.Literals(["disabled"]) }),
  Schema.Struct({ outcome: Schema.Literals(["source_changed"]) }),
]);
export type MemoryWriteOutcome = typeof MemoryWriteOutcome.Type;

export type CreateMemoryOutcome = Extract<
  MemoryWriteOutcome,
  { outcome: "created" | "updated" | "duplicate" | "rejected" | "limit_reached" }
>;
export type UpdateMemoryOutcome = Extract<
  MemoryWriteOutcome,
  { outcome: "updated" | "duplicate" | "rejected" | "not_found" }
>;
export type SaveModelMemoryOutcome = MemoryWriteOutcome;

export const DeleteMemoryOutcome = Schema.Union([
  Schema.Struct({ outcome: Schema.Literals(["deleted"]) }),
  Schema.Struct({ outcome: Schema.Literals(["not_found"]) }),
]);
export type DeleteMemoryOutcome = typeof DeleteMemoryOutcome.Type;

export const standard = Schema.toStandardSchemaV1;
