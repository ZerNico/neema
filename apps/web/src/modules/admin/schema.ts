import { Schema } from "effect";
import { DefaultModelIds } from "~/modules/providers/default-models.ts";
import { MODEL_FORMATS, REASONING_EFFORTS } from "~/modules/providers/model-config.ts";
import {
  ASPECT_RATIOS,
  AUTH_KINDS,
  IMAGE_FAMILIES,
  IMAGE_QUALITIES,
  PRESET_IDS,
  REASONING_SHAPES,
  WIRE_FORMATS,
} from "@chat/model-client";
import { AwsKeys } from "~/modules/providers/aws-keys.ts";
import { CAPABILITY_KEYS } from "~/modules/groups/policy.ts";

export const UpdateDefaultModelOrderInput = Schema.Struct({
  modelIds: DefaultModelIds,
  /** Absent orders chat models, as before image models existed. */
  type: Schema.optionalKey(Schema.Literals(["chat", "image"])),
});

export const UpdateUtilityModelInput = Schema.Struct({
  modelId: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
});

/** Overrides of a preset's settings; the server keeps only those the preset allows. */
export const ProviderSettingsInput = Schema.Struct({
  format: Schema.optionalKey(Schema.Literals(WIRE_FORMATS)),
  reasoning: Schema.optionalKey(Schema.Literals(REASONING_SHAPES)),
  sendReasoning: Schema.optionalKey(Schema.Boolean),
  streamUsage: Schema.optionalKey(Schema.Boolean),
  keyHeader: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{1,64}$/))),
  auth: Schema.optionalKey(Schema.Literals(AUTH_KINDS)),
});

export const CreateProviderInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  preset: Schema.Literals(PRESET_IDS),
  baseUrl: Schema.optionalKey(Schema.String),
  apiKey: Schema.optionalKey(Schema.String),
  /** In place of `apiKey` on a provider that signs with AWS access keys. */
  awsKeys: Schema.optionalKey(AwsKeys),
  settings: Schema.optionalKey(ProviderSettingsInput),
});

export const UpdateProviderInput = Schema.Struct({
  providerId: Schema.String,
  name: Schema.optionalKey(Schema.String),
  baseUrl: Schema.optionalKey(Schema.String),
  apiKey: Schema.optionalKey(Schema.String),
  awsKeys: Schema.optionalKey(AwsKeys),
  enabled: Schema.optionalKey(Schema.Boolean),
  settings: Schema.optionalKey(ProviderSettingsInput),
});

export const ProviderIdInput = Schema.Struct({
  providerId: Schema.String,
});

const NonNegativePrice = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const ChatPricingSchema = Schema.Struct({
  input: NonNegativePrice,
  output: NonNegativePrice,
  cacheRead: Schema.optionalKey(NonNegativePrice),
  cacheWrite: Schema.optionalKey(NonNegativePrice),
});

const EmbeddingPricingSchema = Schema.Struct({
  input: NonNegativePrice,
  output: Schema.Null,
});

const ChatCapabilitiesSchema = Schema.Struct({
  imageOutput: Schema.Boolean,
  reasoning: Schema.Boolean,
  reasoningEfforts: Schema.optionalKey(Schema.Array(Schema.Literals(REASONING_EFFORTS))),
  tools: Schema.Boolean,
  vision: Schema.Boolean,
  files: Schema.Boolean,
});

const EmbeddingCapabilitiesSchema = Schema.Struct({
  imageOutput: Schema.Literal(false),
  reasoning: Schema.Literal(false),
  tools: Schema.Literal(false),
  vision: Schema.Boolean,
  files: Schema.Literal(false),
});

/** One short line in the picker; longer text would crowd the list. */
export const MODEL_DESCRIPTION_MAX = 120;

const CommonModelSettings = {
  displayName: Schema.String.check(Schema.isMinLength(1)),
  description: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(MODEL_DESCRIPTION_MAX))),
  ),
  format: Schema.optionalKey(Schema.NullOr(Schema.Literals(MODEL_FORMATS))),
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

const ImageCapabilitiesSchema = Schema.Struct({
  generate: Schema.Boolean,
  edit: Schema.NullOr(Schema.Struct({ maxReferences: PositiveInteger })),
  aspectRatios: Schema.Array(Schema.Literals(ASPECT_RATIOS)).check(Schema.isMinLength(1)),
  qualities: Schema.Array(Schema.Literals(IMAGE_QUALITIES)),
  transparency: Schema.Boolean,
  maxCount: PositiveInteger,
});

const ImagePricingSchema = Schema.Struct({
  tokens: Schema.optionalKey(
    Schema.Struct({
      textInput: NonNegativePrice,
      imageInput: NonNegativePrice,
      output: NonNegativePrice,
    }),
  ),
  perImage: Schema.optionalKey(
    Schema.Struct({
      default: Schema.optionalKey(NonNegativePrice),
      low: Schema.optionalKey(NonNegativePrice),
      medium: Schema.optionalKey(NonNegativePrice),
      high: Schema.optionalKey(NonNegativePrice),
    }),
  ),
});

const ImageModelSettings = {
  ...CommonModelSettings,
  type: Schema.Literal("image"),
  embeddingDimensions: Schema.Null,
  // Ignored: normalization stores none, image capabilities are their own field.
  capabilities: ChatCapabilitiesSchema,
  pricing: Schema.Null,
  imageFamily: Schema.Literals(IMAGE_FAMILIES),
  imageCapabilities: ImageCapabilitiesSchema,
  imagePricing: Schema.NullOr(ImagePricingSchema),
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
  Schema.Struct({
    providerId: Schema.String,
    modelKey: Schema.String.check(Schema.isMinLength(1)),
    ...ImageModelSettings,
  }),
]);

export const UpdateModelInput = Schema.Union([
  Schema.Struct({ modelId: Schema.String, ...ChatModelSettings }),
  Schema.Struct({ modelId: Schema.String, ...EmbeddingModelSettings }),
  Schema.Struct({ modelId: Schema.String, ...ImageModelSettings }),
]);

export const ModelIdInput = Schema.Struct({
  modelId: Schema.String,
});

export const GROUP_NAME_MAX = 100;

export const CreateGroupInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(GROUP_NAME_MAX)),
});

export const RenameGroupInput = Schema.Struct({
  groupId: Schema.String,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(GROUP_NAME_MAX)),
});

export const CapabilitiesInput = Schema.Struct(
  Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, Schema.Boolean])) as Record<
    (typeof CAPABILITY_KEYS)[number],
    typeof Schema.Boolean
  >,
);

export const UpdateDefaultCapabilitiesInput = Schema.Struct({ capabilities: CapabilitiesInput });
export const UpdateGroupCapabilitiesInput = Schema.Struct({
  groupId: Schema.String,
  capabilities: CapabilitiesInput,
});

export const GroupIdInput = Schema.Struct({
  groupId: Schema.String,
});

export const GroupMemberInput = Schema.Struct({
  groupId: Schema.String,
  userId: Schema.String,
});

export const UpdateGroupMemberSharingInput = Schema.Struct({
  ...GroupMemberInput.fields,
  sharing: Schema.Struct({
    agents: Schema.Boolean,
    knowledge: Schema.Boolean,
    skills: Schema.Boolean,
    projects: Schema.Boolean,
  }),
});

/** A model on a provider, saved or not yet; what the probes below need. */
export const ProbeModelInput = Schema.Struct({
  providerId: Schema.String,
  modelKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  format: Schema.optionalKey(Schema.NullOr(Schema.Literals(MODEL_FORMATS))),
});
