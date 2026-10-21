import { useQuery } from "@tanstack/react-query";
import { ListCard, ListRow, Section } from "~/ui/page-shell.tsx";
import { Progress } from "~/ui/primitives/progress";
import { myLimitsQuery } from "../client/queries.ts";
import { formatAmount, PERIOD_WORDS, type LimitStanding } from "../rules.ts";

/** "resets at midnight", "resets Monday", "resets 1 Nov", in the reader's own clock. */
const resets = (limit: LimitStanding) => {
  const at = new Date(limit.resetsAt);
  if (limit.period === "day")
    return `resets at ${at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  return `resets ${at.toLocaleDateString(undefined, {
    ...(limit.period === "week" ? { weekday: "long" } : {}),
    day: "numeric",
    month: "short",
  })}`;
};

const usedOf = (limit: LimitStanding) =>
  limit.metric === "cost"
    ? `${formatAmount("cost", limit.used)} of ${formatAmount("cost", limit.amount)}`
    : `${limit.used} of ${formatAmount("answers", limit.amount)}`;

/** Every limit the person is held to, with how much of each is used; nothing without limits. */
export function MyLimitsSection() {
  const { data: limits = [] } = useQuery(myLimitsQuery);
  if (!limits.length) return null;
  return (
    <Section title="Limits" description="Set by your admin. Answers stop once one is used up.">
      <ListCard>
        {limits.map((limit) => (
          <ListRow
            key={`${limit.metric}:${limit.period}:${limit.models?.map((model) => model.id).join(",") ?? "*"}`}
            className="flex-col items-stretch gap-2"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
              <span className="font-medium">
                {usedOf(limit)} {PERIOD_WORDS[limit.period].current}
                {limit.models ? (
                  <span className="text-muted-foreground font-normal">
                    {" "}
                    · {limit.models.map((model) => model.name).join(", ")}
                  </span>
                ) : null}
              </span>
              <span className="text-muted-foreground text-xs">
                {limit.reached ? "Used up · " : ""}
                {resets(limit)}
              </span>
            </div>
            <Progress
              value={Math.min(100, (limit.used / limit.amount) * 100)}
              aria-label={`${usedOf(limit)} ${PERIOD_WORDS[limit.period].current}`}
            />
          </ListRow>
        ))}
      </ListCard>
    </Section>
  );
}
