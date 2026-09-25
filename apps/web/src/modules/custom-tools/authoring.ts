import { Effect, Schema, SchemaGetter, SchemaIssue } from "effect";

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
  options: { readonly name: string; readonly mediaType?: string; readonly share?: boolean },
): CustomToolFile {
  if (!options.name.trim()) throw new Error("A tool file needs a name.");
  return Object.freeze({
    [fileBrand]: true as const,
    name: options.name,
    // Only a hint: the server decides the type from the bytes and the name.
    mediaType: options.mediaType?.trim() || "application/octet-stream",
    bytes: typeof data === "string" ? new TextEncoder().encode(data) : data,
    share: options.share ?? false,
  });
}

export const isCustomToolFile = (value: unknown): value is CustomToolFile =>
  typeof value === "object" &&
  value !== null &&
  (value as { [fileBrand]?: unknown })[fileBrand] === true;

/** A file the model passed to a tool, resolved and permission-checked by the host. */
export interface ToolInputFile {
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly bytes: Uint8Array;
  /** The bytes as UTF-8 text. */
  text(): string;
}

export interface FileInputOptions {
  /** What the file is for, in the model's terms. */
  readonly description?: string;
  /** Extensions (`.pptx`) or media types (`image/png`, `image/*`) the tool takes. */
  readonly accept?: ReadonlyArray<string>;
}

/**
 * Set by the worker for the length of one call: turns what the model passed
 * into the file's bytes, or explains why it cannot.
 */
const fileResolverKey = Symbol.for("chat/custom-tools/file-resolver");
type FileResolver = (
  reference: string,
) => Promise<{ readonly name: string; readonly mediaType: string; readonly bytes: Uint8Array }>;

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
};
export const fileAccepts = (
  accept: ReadonlyArray<string>,
  candidate: { readonly name: string; readonly mediaType: string },
) =>
  accept.length === 0 ||
  accept.some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (rule.startsWith(".")) return extensionOf(candidate.name) === rule;
    if (rule.endsWith("/*")) return candidate.mediaType.startsWith(rule.slice(0, -1));
    return candidate.mediaType === rule;
  });

const isInputFile = (value: unknown): value is ToolInputFile =>
  typeof value === "object" &&
  value !== null &&
  (value as ToolInputFile).bytes instanceof Uint8Array;

/**
 * A parameter the model fills with a file from the chat or its project. It
 * advertises a string (the file's id or name) and decodes to the file itself,
 * fetched when the call is made; `accept` is checked before `run` sees it.
 */
export function fileInput(options: FileInputOptions = {}): Schema.Codec<ToolInputFile, string> {
  const accept = options.accept ?? [];
  const description = [
    options.description,
    "Pass the id or exact name of a file in this chat or its project.",
    accept.length ? `Accepts ${accept.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return Schema.String.annotate({ description }).pipe(
    Schema.decodeTo(Schema.declare(isInputFile, { expected: "a file" }), {
      decode: SchemaGetter.transformEffect((reference: string) =>
        Effect.tryPromise({
          try: async () => {
            const resolve = (globalThis as { [fileResolverKey]?: FileResolver })[fileResolverKey];
            if (!resolve) throw new Error("Files are not available here.");
            const found = await resolve(reference);
            if (!fileAccepts(accept, found))
              throw new Error(
                `${found.name} is ${found.mediaType}; this takes ${accept.join(", ")}.`,
              );
            const input: ToolInputFile = {
              name: found.name,
              mediaType: found.mediaType,
              size: found.bytes.length,
              bytes: found.bytes,
              text: () => new TextDecoder().decode(found.bytes),
            };
            return input;
          },
          catch: (cause) =>
            new SchemaIssue.InvalidValue({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        }),
      ),
      encode: SchemaGetter.transform((input: ToolInputFile) => input.name),
    }),
  );
}

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
