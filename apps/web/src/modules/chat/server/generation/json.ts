import type { Prompt } from "effect/ai";
import type { JsonValue } from "~/db/schema/providers.ts";

// Projected activities are literal structs; one widening at the boundary
// beats an assertion chain at every persistence site.
/**
 * Schema-validated tool output is plain JSON at runtime, but readonly arrays
 * and optional keys keep TS from proving that against the recursive JsonValue
 * type. Stated here once rather than at every row that stores a result.
 */
export const json = (value: unknown) => value as JsonValue;

/** Same boundary for a decoded Prompt: its content is already message-shaped. */
export const promptMessages = (prompt: { content: unknown }) =>
  prompt.content as ReadonlyArray<Prompt.MessageEncoded>;
