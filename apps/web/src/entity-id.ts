import { Schema } from "effect";

/** A stored row's id as a request names it: never empty, never longer than any id the app mints. */
export const EntityId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
