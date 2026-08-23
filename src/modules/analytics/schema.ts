import { Schema } from "effect";

// Preset ranges only — arbitrary dates buy nothing here and would complicate
// caching and the SQL scope.
export const UsageRangeInput = Schema.Struct({
  days: Schema.Literals([7, 30, 90]),
});

export type UsageRangeDays = typeof UsageRangeInput.Type.days;
