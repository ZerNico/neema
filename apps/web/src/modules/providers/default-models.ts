import { Schema } from "effect";

export const MAX_DEFAULT_MODELS = 100;

export const DefaultModelIds = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
).check(Schema.isMaxLength(MAX_DEFAULT_MODELS), Schema.isUnique());

export class InvalidDefaultModelOrder extends Schema.TaggedError<InvalidDefaultModelOrder>()(
  "InvalidDefaultModelOrder",
  { reason: Schema.String },
) {}

export class InvalidUtilityModel extends Schema.TaggedError<InvalidUtilityModel>()(
  "InvalidUtilityModel",
  { reason: Schema.String },
) {}

/**
 * Input is already authorized and in display order. Rank affects selection,
 * never presentation; strip it before returning rows to the chat client.
 */
export function markDefaultModel<T extends { id: string; defaultPriority: number | null }>(
  models: ReadonlyArray<T>,
): Array<Omit<T, "defaultPriority"> & { isDefault: boolean }> {
  let winner = models[0];
  for (const model of models) {
    if (
      model.defaultPriority !== null &&
      (winner?.defaultPriority == null || model.defaultPriority < winner.defaultPriority)
    ) {
      winner = model;
    }
  }
  return models.map(({ defaultPriority: _, ...model }) => ({
    ...model,
    isDefault: model.id === winner?.id,
  }));
}
