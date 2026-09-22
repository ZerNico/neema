import { Schema } from "effect";

/**
 * The `@chat/custom-tools` runtime. The builder bundles this file (see
 * `custom-tool-runtime-worker-plugin.ts`) and inlines it into every authored
 * module; the matching type surface lives in `authoring-declaration.ts`, and
 * `builder.test.ts` compiles a module against both, so they cannot drift
 * without a failing test.
 */
export { Schema };

export const CUSTOM_TOOL_MODULE_ID = "@chat/custom-tools";

const functionSlugPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const functionSlugMax = 27;

/**
 * A file a tool hands back. The brand is a symbol so a plain object that
 * happens to have `name` and `bytes` stays an ordinary JSON result.
 */
const fileBrand: unique symbol = Symbol.for("chat/custom-tools/file");

export interface CustomToolFile {
  readonly [fileBrand]: true;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  /** Also put the file in front of the model on its next turn. Off by default. */
  readonly share: boolean;
}

/** What `run` may return: text, JSON, or text plus files. */
export interface CustomToolOutput {
  readonly text?: unknown;
  readonly files?: ReadonlyArray<CustomToolFile>;
}

export function file(
  data: Uint8Array | string,
  options: { readonly name: string; readonly mediaType: string; readonly share?: boolean },
): CustomToolFile {
  if (!options.name.trim()) throw new Error("A tool file needs a name.");
  if (!options.mediaType.trim()) throw new Error("A tool file needs a media type.");
  return Object.freeze({
    [fileBrand]: true as const,
    name: options.name,
    mediaType: options.mediaType,
    bytes: typeof data === "string" ? new TextEncoder().encode(data) : data,
    share: options.share ?? false,
  });
}

export const isCustomToolFile = (value: unknown): value is CustomToolFile =>
  typeof value === "object" &&
  value !== null &&
  (value as { [fileBrand]?: unknown })[fileBrand] === true;

export interface CustomToolDefinition<
  S extends Schema.Codec<unknown, unknown, never, unknown> = Schema.Codec<
    unknown,
    unknown,
    never,
    unknown
  >,
> {
  readonly name: string;
  readonly description: string;
  readonly parameters: S;
  readonly run: {
    bivarianceHack(args: S["Type"]): unknown | PromiseLike<unknown>;
  }["bivarianceHack"];
}

export type CustomToolModule = Readonly<Record<string, CustomToolDefinition>>;

export function defineTool<S extends Schema.Codec<unknown, unknown, never, unknown>>(
  definition: CustomToolDefinition<S>,
): CustomToolDefinition<S> {
  if (!definition.name.trim()) throw new Error("A custom tool function needs a name.");
  if (!definition.description.trim()) {
    throw new Error("A custom tool function needs a description.");
  }
  if (!Schema.isSchema(definition.parameters)) {
    throw new Error("A custom tool function needs an Effect Schema for its parameters.");
  }
  if (typeof definition.run !== "function") {
    throw new Error("A custom tool function needs a run function.");
  }
  return Object.freeze(definition);
}

export function defineModule<const M extends CustomToolModule>(module: M): M {
  const entries = Object.entries(module);
  if (entries.length === 0)
    throw new Error("A custom tool module must define at least one function.");
  for (const [key, definition] of entries) {
    if (key.length > functionSlugMax || !functionSlugPattern.test(key)) {
      throw new Error(
        `Invalid function key ${JSON.stringify(key)}. Use lowercase slug segments up to ${functionSlugMax} characters.`,
      );
    }
    defineTool(definition);
  }
  return Object.freeze(module);
}
