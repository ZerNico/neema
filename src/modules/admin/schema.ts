import { Schema } from "effect";

export const CreateProviderInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  kind: Schema.Literals(["openrouter", "openai-compatible"]),
  baseUrl: Schema.String.check(Schema.isMinLength(1)),
  apiKey: Schema.String.check(Schema.isMinLength(1)),
});

export const UpdateProviderInput = Schema.Struct({
  providerId: Schema.String,
  name: Schema.optionalKey(Schema.String),
  baseUrl: Schema.optionalKey(Schema.String),
  apiKey: Schema.optionalKey(Schema.String),
  enabled: Schema.optionalKey(Schema.Boolean),
});

export const ProviderIdInput = Schema.Struct({
  providerId: Schema.String,
});

const CapabilitiesSchema = Schema.Struct({
  reasoning: Schema.Boolean,
  tools: Schema.Boolean,
  vision: Schema.Boolean,
  files: Schema.Boolean,
});

export const CreateModelInput = Schema.Struct({
  providerId: Schema.String,
  modelKey: Schema.String.check(Schema.isMinLength(1)),
  displayName: Schema.String.check(Schema.isMinLength(1)),
  type: Schema.Literals(["chat", "embedding", "image", "audio"]),
  contextLength: Schema.optionalKey(Schema.Number),
  capabilities: Schema.optionalKey(CapabilitiesSchema),
});

export const UpdateModelInput = Schema.Struct({
  modelId: Schema.String,
  displayName: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.Literals(["chat", "embedding", "image", "audio"])),
  contextLength: Schema.optionalKey(Schema.Number),
  capabilities: Schema.optionalKey(CapabilitiesSchema),
  enabled: Schema.optionalKey(Schema.Boolean),
});

export const ModelIdInput = Schema.Struct({
  modelId: Schema.String,
});

export const CreateGroupInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});

export const RenameGroupInput = Schema.Struct({
  groupId: Schema.String,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});

export const GroupIdInput = Schema.Struct({
  groupId: Schema.String,
});

export const GroupMemberInput = Schema.Struct({
  groupId: Schema.String,
  userId: Schema.String,
});

export const UpdateModelAccessInput = Schema.Struct({
  modelId: Schema.String,
  access: Schema.Literals(["public", "groups"]),
  groupIds: Schema.Array(Schema.String),
});
