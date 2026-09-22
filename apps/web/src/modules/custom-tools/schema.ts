import { Schema } from "effect";
import type { JsonValue } from "~/db/schema/providers.ts";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "~/modules/attachments/constants.ts";

export const CUSTOM_TOOL_LIMITS = {
  slug: 27,
  functionSlug: 27,
  name: 80,
  description: 500,
  sourceChars: 65_536,
  dependencies: 10,
  packageName: 214,
  packageVersion: 64,
  functions: 16,
  parametersChars: 8_192,
  totalParametersChars: 65_536,
  bundleBytes: 5 * 1024 * 1024,
  resultChars: 32_768,
  resultPreviewChars: 500,
  files: MAX_ATTACHMENTS_PER_MESSAGE,
  fileBytes: MAX_ATTACHMENT_BYTES,
  totalFileBytes: MAX_ATTACHMENT_BYTES * 2,
  testFileBytes: 2 * 1024 * 1024,
  errorChars: 300,
  timeoutMs: 30_000,
  testTimeoutMs: 10_000,
  buildTimeoutMs: 120_000,
} as const;

export const CUSTOM_TOOL_PREFIX = "custom_";

export const customToolName = (moduleSlug: string, functionSlug: string) =>
  `${CUSTOM_TOOL_PREFIX}${moduleSlug}__${functionSlug}`;

export const isCustomToolName = (name: string): boolean => name.startsWith(CUSTOM_TOOL_PREFIX);

const slugPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const slugMessage =
  "Lowercase letters, digits and single underscores; start with a letter, up to 27 characters";

export const CustomToolSlug = Schema.String.check(
  Schema.isPattern(slugPattern, { message: slugMessage }),
  Schema.isMaxLength(CUSTOM_TOOL_LIMITS.slug),
);
export type CustomToolSlug = typeof CustomToolSlug.Type;

export const CustomToolFunctionSlug = Schema.String.check(
  Schema.isPattern(slugPattern, { message: slugMessage }),
  Schema.isMaxLength(CUSTOM_TOOL_LIMITS.functionSlug),
);

export const CustomToolDependency = Schema.Struct({
  name: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CUSTOM_TOOL_LIMITS.packageName),
  ),
  version: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CUSTOM_TOOL_LIMITS.packageVersion),
  ),
});
export type CustomToolDependency = typeof CustomToolDependency.Type;

export interface CustomToolFunctionManifest {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly modelName: string;
  readonly parametersSchema: Record<string, JsonValue>;
}

/** What one attempt runs: the module's bundle and functions as of turn time. */
export interface CustomToolManifest {
  readonly toolId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly compiled: string;
  readonly functions: ReadonlyArray<CustomToolFunctionManifest>;
}

const Source = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(CUSTOM_TOOL_LIMITS.sourceChars),
);
const Name = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(CUSTOM_TOOL_LIMITS.name),
);
const Description = Schema.String.check(Schema.isMaxLength(CUSTOM_TOOL_LIMITS.description));
const Dependencies = Schema.Array(CustomToolDependency).check(
  Schema.isMaxLength(CUSTOM_TOOL_LIMITS.dependencies),
);
const ToolId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

export const CustomToolIdInput = Schema.Struct({ toolId: ToolId });

/** The identity fields the editor validates itself; source and dependencies are checked by the build. */
export const CustomToolIdentityInput = Schema.Struct({
  slug: CustomToolSlug,
  name: Name,
  description: Description,
});

export const CreateCustomToolInput = Schema.Struct({
  slug: CustomToolSlug,
  name: Name,
  description: Description,
  source: Source,
  dependencies: Dependencies,
});

export const UpdateCustomToolInput = Schema.Struct({
  toolId: ToolId,
  /** Renaming re-derives the model-facing names, so a save always rebuilds. */
  slug: CustomToolSlug,
  /** The `version` the editor loaded; a save against another one is refused. */
  expectedVersion: ToolId,
  name: Name,
  description: Description,
  source: Source,
  dependencies: Dependencies,
});

export const SaveCustomToolInput = Schema.Union([CreateCustomToolInput, UpdateCustomToolInput]);

export const SetCustomToolEnabledInput = Schema.Struct({
  ...CustomToolIdInput.fields,
  enabled: Schema.Boolean,
});

export const CheckCustomToolInput = Schema.Struct({
  slug: CustomToolSlug,
  source: Source,
  dependencies: Dependencies,
});

export const TestCustomToolInput = Schema.Struct({
  ...CheckCustomToolInput.fields,
  functionKey: CustomToolFunctionSlug,
  argumentsJson: Schema.String.check(Schema.isMaxLength(CUSTOM_TOOL_LIMITS.resultChars)),
});

export interface CustomToolSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
  audience: "private" | "instance";
  version: string;
  functionCount: number;
  dependencyCount: number;
  updatedAt: string;
}

export interface CustomToolDetail extends CustomToolSummary {
  source: string;
  dependencies: ReadonlyArray<CustomToolDependency>;
  functions: ReadonlyArray<CustomToolFunctionManifest>;
}

export interface CustomToolBuildPreview {
  functions: ReadonlyArray<CustomToolFunctionManifest>;
}

/** A file returned during an admin Test: there is no message to attach it to. */
export interface CustomToolTestFile {
  name: string;
  mediaType: string;
  size: number;
  /** `data:` URL for previewing, absent past `CUSTOM_TOOL_LIMITS.testFileBytes`. */
  dataUrl?: string;
}

export interface CustomToolTestResult {
  ok: boolean;
  output: string;
  durationMs: number;
  logs: ReadonlyArray<string>;
  files: ReadonlyArray<CustomToolTestFile>;
}
