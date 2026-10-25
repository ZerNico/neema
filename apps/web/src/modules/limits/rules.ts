import { m } from "~/paraglide/messages.js";
import { getLocale, type Locale } from "~/paraglide/runtime.js";

export const LIMIT_METRICS = ["cost", "answers"] as const;
export type LimitMetric = (typeof LIMIT_METRICS)[number];

export const LIMIT_PERIODS = ["day", "week", "month"] as const;
export type LimitPeriod = (typeof LIMIT_PERIODS)[number];

/** One stored rule, everyone's when `groupId` is null. */
export interface LimitRule {
  readonly id: string;
  readonly groupId: string | null;
  readonly metric: LimitMetric;
  readonly period: LimitPeriod;
  /** Null lifts everyone's rule for a group. */
  readonly amount: number | null;
  /** Null for every model; otherwise the ids it counts and stops. */
  readonly modelIds: ReadonlyArray<string> | null;
}

/** A limit a person is held to, after their groups had their say. */
export interface EffectiveLimit {
  readonly metric: LimitMetric;
  readonly period: LimitPeriod;
  readonly amount: number;
  readonly modelIds: ReadonlyArray<string> | null;
  /** The rule it comes from: everyone's, or the group rule that won. */
  readonly ruleId: string;
}

/** One limit a person is held to, with how much of it is used and when it opens again. */
export interface LimitStanding {
  readonly metric: LimitMetric;
  readonly period: LimitPeriod;
  readonly amount: number;
  readonly used: number;
  /** Null for every model; otherwise the names of those it counts. */
  readonly models: ReadonlyArray<{ id: string; name: string }> | null;
  readonly resetsAt: string;
  readonly reached: boolean;
}

/** What makes two rules the same limit: what they count, over what, for which models. */
export const limitKey = (rule: Pick<LimitRule, "metric" | "period" | "modelIds">) =>
  `${rule.metric}:${rule.period}:${rule.modelIds ? rule.modelIds.toSorted().join(",") : "*"}`;

/**
 * Everyone's rules hold for all but admins. A group's rule replaces everyone's
 * for the same limit; among several groups the most generous wins, and one
 * group's "No limit" lifts it. A group silent on a limit leaves it as it is.
 */
export const effectiveLimits = (
  everyone: ReadonlyArray<LimitRule>,
  fromGroups: ReadonlyArray<LimitRule>,
): EffectiveLimit[] => {
  const byKey = new Map<string, { base?: LimitRule; groups: LimitRule[] }>();
  // A rule whose models are all gone counts and stops nothing.
  const live = (rule: LimitRule) => rule.modelIds === null || rule.modelIds.length > 0;
  const entry = (rule: LimitRule) => {
    const key = limitKey(rule);
    let found = byKey.get(key);
    if (!found) byKey.set(key, (found = { groups: [] }));
    return found;
  };
  // Two of everyone's rules can come to mean the same limit (a deleted model); the stricter holds.
  for (const rule of everyone.filter(live)) {
    const found = entry(rule);
    if (!found.base || (rule.amount ?? Infinity) < (found.base.amount ?? Infinity))
      found.base = rule;
  }
  for (const rule of fromGroups.filter(live)) entry(rule).groups.push(rule);
  const limits: EffectiveLimit[] = [];
  for (const { base, groups } of byKey.values()) {
    const winner = groups.length
      ? groups.some((rule) => rule.amount === null)
        ? null
        : groups.reduce((best, rule) => (rule.amount! > best.amount! ? rule : best))
      : (base ?? null);
    if (!winner || winner.amount === null) continue;
    limits.push({
      metric: winner.metric,
      period: winner.period,
      amount: winner.amount,
      modelIds: winner.modelIds,
      ruleId: winner.id,
    });
  }
  return limits;
};

/** Whether a limit counts and stops calls of this model. */
export const coversModel = (limit: Pick<EffectiveLimit, "modelIds">, modelId: string) =>
  limit.modelIds === null || limit.modelIds.includes(modelId);

/** "$10.00" or "20 answers", in the reader's locale unless the caller names one. */
export const formatAmount = (metric: LimitMetric, amount: number, locale: Locale = getLocale()) =>
  metric === "cost"
    ? new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(amount)
    : m.limits_amount_answers({ count: amount }, { locale });

/**
 * The bytes a person may store: everyone's quota, unless groups set their own, when the most
 * generous of those wins and one without a number lifts it.
 */
export const effectiveQuota = (
  everyone: number | null,
  fromGroups: ReadonlyArray<number | null>,
): number | null =>
  fromGroups.length
    ? fromGroups.some((bytes) => bytes === null)
      ? null
      : Math.max(...(fromGroups as number[]))
    : everyone;

/** "1.5 GB", "300 MB", in the binary units file managers use. */
export const formatBytes = (bytes: number, locale: Locale = getLocale()) => {
  const units = ["bytes", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return m.limits_bytes({ count: value }, { locale });
  const digits = value >= 10 ? 0 : 1;
  const size = new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
  return m.limits_size({ size, unit: units[unit]! }, { locale });
};

/** The largest files Settings › Storage lists; past it the list says it is cut. */
export const LIBRARY_LISTED = 500;
