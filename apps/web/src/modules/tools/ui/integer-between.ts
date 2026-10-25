import { Schema } from "effect";
import { m } from "~/paraglide/messages.js";

/**
 * Number inputs are kept as strings in form state (what the <input> holds);
 * the schema parses and range-checks them, so a typo shows as a field error
 * instead of silently disabling Save. Call it where the form is built, so its
 * messages are read in the page's locale.
 */
export const integerBetween = (minimum: number, maximum: number) =>
  Schema.NumberFromString.check(
    Schema.isInt({ message: m.tools_field_whole_number() }),
    Schema.isBetween(
      { minimum, maximum },
      { message: m.tools_field_between({ min: minimum, max: maximum }) },
    ),
  );
