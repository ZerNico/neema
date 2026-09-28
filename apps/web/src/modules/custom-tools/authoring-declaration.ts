/**
 * Ambient types for `@chat/custom-tools`, written into every build's type
 * check project. Mirrors `authoring.ts`; keep the two in step.
 */
export const CUSTOM_TOOL_AUTHORING_DECLARATION = `
declare module "@chat/custom-tools" {
  export { Schema } from "effect";
  import { Schema as EffectSchema } from "effect";

  export interface CustomToolDefinition<S extends EffectSchema.Codec<unknown, unknown, never, unknown> = EffectSchema.Codec<unknown, unknown, never, unknown>> {
    readonly name: string;
    readonly description: string;
    readonly parameters: S;
    readonly run: {
    bivarianceHack(args: S["Type"]): unknown | PromiseLike<unknown>;
  }["bivarianceHack"];
  }

  export type CustomToolModule = Readonly<Record<string, CustomToolDefinition>>;

  export type FileRef =
    | { readonly kind: "attachment"; readonly id: string }
    | { readonly kind: "project"; readonly id: string; readonly version: number }
    | { readonly kind: "working"; readonly id: string; readonly revision: number };

  /** A file a tool hands back; make one with \`file(...)\`. */
  export interface CustomToolFile {
    readonly name: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
    readonly delivery: "working" | "publish";
    readonly replaces?: Extract<FileRef, { kind: "working" }>;
    readonly showModel: boolean;
  }

  /** Text (or any JSON) for the model plus files for the user; either half may be omitted. */
  export interface CustomToolOutput {
    readonly text?: unknown;
    readonly files?: ReadonlyArray<CustomToolFile>;
  }

  /** \`mediaType\` is optional; the server decides the type from the bytes and the name. */
  export function file(
    data: Uint8Array | string,
    options:
      | { readonly name: string; readonly mediaType?: string; readonly delivery: "working"; readonly replaces?: Extract<FileRef, { kind: "working" }>; readonly showModel?: boolean }
      | { readonly name: string; readonly mediaType?: string; readonly delivery: "publish"; readonly replaces?: never; readonly showModel?: boolean },
  ): CustomToolFile;

  /** A file the model passed to a tool, resolved and permission-checked by the host. */
  export interface ToolInputFile {
    readonly name: string;
    readonly mediaType: string;
    readonly size: number;
    readonly bytes: Uint8Array;
    readonly ref: FileRef;
    /** The bytes as UTF-8 text. */
    text(): string;
  }

  export interface FileInputOptions {
    /** What the file is for, in the model's terms. */
    readonly description?: string;
    /** Extensions (\`.pptx\`) or media types (\`image/png\`, \`image/*\`) the tool takes. */
    readonly accept?: ReadonlyArray<string>;
  }

  /**
   * A parameter the model fills with a file from the chat or its project. The
   * model passes an id or name; \`run\` receives the file itself.
   */
  export function fileInput(options?: FileInputOptions): EffectSchema.Codec<ToolInputFile, string>;

  export function defineTool<S extends EffectSchema.Codec<unknown, unknown, never, unknown>>(
    definition: CustomToolDefinition<S>,
  ): CustomToolDefinition<S>;

  export function defineModule<const M extends CustomToolModule>(module: M): M;
}
`;
