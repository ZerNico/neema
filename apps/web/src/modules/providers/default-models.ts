import { Schema } from "effect";
import { Localized } from "~/i18n/localized.ts";

/** The whole chat catalog is ordered, and an aggregator can bring hundreds. */
export const MAX_DEFAULT_MODELS = 1000;

export const DefaultModelIds = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
).check(Schema.isMaxLength(MAX_DEFAULT_MODELS), Schema.isUnique());

export class InvalidDefaultModelOrder extends Schema.TaggedError<InvalidDefaultModelOrder>()(
  "InvalidDefaultModelOrder",
  { reason: Localized },
) {}

export class InvalidUtilityModel extends Schema.TaggedError<InvalidUtilityModel>()(
  "InvalidUtilityModel",
  { reason: Localized },
) {}

/** An image model whose family its provider cannot serve. */
export class UnhostedImageFamily extends Schema.TaggedError<UnhostedImageFamily>()(
  "UnhostedImageFamily",
  { reason: Localized },
) {}

/**
 * Input is already authorized and in the admin's order, so the first row a
 * person can use is their default. Strip the rank before returning rows to the
 * chat client: the order it arrives in is all it needs.
 */
export function markDefaultModel<T extends { id: string; defaultPriority: number | null }>(
  models: ReadonlyArray<T>,
): Array<Omit<T, "defaultPriority"> & { isDefault: boolean }> {
  return models.map(({ defaultPriority: _, ...model }, index) => ({
    ...model,
    isDefault: index === 0,
  }));
}
