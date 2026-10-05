import { Option, Schema } from "effect";

/**
 * AWS access keys travel and rest as one JSON document in the provider's
 * encrypted key column, so a signing provider needs no columns of its own.
 */
export const AwsKeys = Schema.Struct({
  accessKeyId: Schema.String.check(Schema.isPattern(/^[A-Z0-9]{16,128}$/)),
  secretAccessKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
});
export type AwsKeys = typeof AwsKeys.Type;

export const encodeAwsKeys = (keys: AwsKeys) => JSON.stringify(keys);

/** The stored keys, or undefined when the row holds something else. */
export const decodeAwsKeys = (stored: string): AwsKeys | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return undefined;
  }
  return Option.getOrUndefined(Schema.decodeUnknownOption(AwsKeys)(parsed));
};
