import { Schema } from "effect";
import { LIMIT_METRICS, LIMIT_PERIODS } from "./rules.ts";

export const SaveLimitInput = Schema.Struct({
  id: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
  groupId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
  metric: Schema.Literals(LIMIT_METRICS),
  period: Schema.Literals(LIMIT_PERIODS),
  amount: Schema.NullOr(Schema.Number),
  modelIds: Schema.NullOr(
    Schema.Array(Schema.String.check(Schema.isMaxLength(64))).check(Schema.isMaxLength(100)),
  ),
});

export const LimitIdInput = Schema.Struct({ id: Schema.String.check(Schema.isMaxLength(64)) });

export const TimeZoneInput = Schema.Struct({
  timeZone: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
