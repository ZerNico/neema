import { Schema } from "effect";

/**
 * Number inputs are kept as strings in form state (what the <input> holds);
 * the schema parses and range-checks them, so a typo shows as a field error
 * instead of silently disabling Save.
 */
export const integerBetween = (minimum: number, maximum: number) =>
  Schema.NumberFromString.check(
    Schema.isInt({ message: "Enter a whole number." }),
    Schema.isBetween({ minimum, maximum }, { message: `Between ${minimum} and ${maximum}.` }),
  );
