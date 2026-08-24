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

const NonNegativePrice = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const ChatPricingSchema = Schema.Struct({
  input: NonNegativePrice,
  output: NonNegativePrice,
});

const EmbeddingPricingSchema = Schema.Struct({
  input: NonNegativePrice,
  output: Schema.Null,
});

const ChatCapabilitiesSchema = Schema.Struct({
  reasoning: Schema.Boolean,
  tools: Schema.Boolean,
  vision: Schema.Boolean,
  files: Schema.Boolean,
});

const EmbeddingCapabilitiesSchema = Schema.Struct({
  reasoning: Schema.Literal(false),
  tools: Schema.Literal(false),
  vision: Schema.Boolean,
  files: Schema.Literal(false),
});

const CommonModelSettings = {
  displayName: Schema.String.check(Schema.isMinLength(1)),
  contextLength: Schema.NullOr(PositiveInteger),
  enabled: Schema.Boolean,
  access: Schema.Literals(["public", "groups"]),
  groupIds: Schema.Array(Schema.String),
};

const ChatModelSettings = {
  ...CommonModelSettings,
  type: Schema.Literal("chat"),
  embeddingDimensions: Schema.Null,
  capabilities: ChatCapabilitiesSchema,
  pricing: Schema.NullOr(ChatPricingSchema),
};

const EmbeddingModelSettings = {
  ...CommonModelSettings,
  type: Schema.Literal("embedding"),
  embeddingDimensions: Schema.NullOr(PositiveInteger),
  capabilities: EmbeddingCapabilitiesSchema,
  pricing: Schema.NullOr(EmbeddingPricingSchema),
};

export const CreateModelInput = Schema.Union([
  Schema.Struct({
    providerId: Schema.String,
    modelKey: Schema.String.check(Schema.isMinLength(1)),
    ...ChatModelSettings,
  }),
  Schema.Struct({
    providerId: Schema.String,
    modelKey: Schema.String.check(Schema.isMinLength(1)),
    ...EmbeddingModelSettings,
  }),
]);

export const UpdateModelInput = Schema.Union([
  Schema.Struct({ modelId: Schema.String, ...ChatModelSettings }),
  Schema.Struct({ modelId: Schema.String, ...EmbeddingModelSettings }),
]);

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
