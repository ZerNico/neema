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

  /** A file a tool hands back; make one with \`file(...)\`. */
  export interface CustomToolFile {
    readonly name: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
    /** Also put the file in front of the model on its next turn. Off by default. */
    readonly share: boolean;
  }

  /** Text (or any JSON) for the model plus files for the user; either half may be omitted. */
  export interface CustomToolOutput {
    readonly text?: unknown;
    readonly files?: ReadonlyArray<CustomToolFile>;
  }

  export function file(
    data: Uint8Array | string,
    options: { readonly name: string; readonly mediaType: string; readonly share?: boolean },
  ): CustomToolFile;

  export function defineTool<S extends EffectSchema.Codec<unknown, unknown, never, unknown>>(
    definition: CustomToolDefinition<S>,
  ): CustomToolDefinition<S>;

  export function defineModule<const M extends CustomToolModule>(module: M): M;
}
`;
