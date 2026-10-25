import { useQuery } from "@tanstack/react-query";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";
import { ListCard, ListRow, Section } from "~/ui/page-shell.tsx";
import { Progress } from "~/ui/primitives/progress";
import { myLimitsQuery } from "../client/queries.ts";
import { formatAmount, type LimitStanding } from "../rules.ts";

/** "resets at midnight", "resets Monday", "resets 1 Nov", in the reader's own clock. */
const resets = (limit: LimitStanding) => {
  const at = new Date(limit.resetsAt);
  if (limit.period === "day")
    return m.limits_mine_resets_at({
      time: at.toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" }),
    });
  return m.limits_mine_resets_on({
    day: at.toLocaleDateString(getLocale(), {
      ...(limit.period === "week" ? { weekday: "long" } : {}),
      day: "numeric",
      month: "short",
    }),
  });
};

/** "$2.00 of $10.00 today", "4 of 20 answers this week". */
const usage = (limit: LimitStanding) =>
  m.limits_mine_usage({
    period: limit.period,
    used: limit.metric === "cost" ? formatAmount("cost", limit.used) : limit.used,
    amount: formatAmount(limit.metric, limit.amount),
  });

/** Every limit the person is held to, with how much of each is used; nothing without limits. */
export function MyLimitsSection() {
  const { data: limits = [] } = useQuery(myLimitsQuery);
  if (!limits.length) return null;
  return (
    <Section title={m.limits_mine_title()} description={m.limits_mine_description()}>
      <ListCard>
        {limits.map((limit) => (
          <ListRow
            key={`${limit.metric}:${limit.period}:${limit.models?.map((model) => model.id).join(",") ?? "*"}`}
            className="flex-col items-stretch gap-2"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
              <span className="font-medium">
                {usage(limit)}
                {limit.models ? (
                  <span className="text-muted-foreground font-normal">
                    {" "}
                    · {limit.models.map((model) => model.name).join(", ")}
                  </span>
                ) : null}
              </span>
              <span className="text-muted-foreground text-xs">
                {limit.reached ? `${m.limits_mine_used_up()} · ` : ""}
                {resets(limit)}
              </span>
            </div>
            <Progress
              value={Math.min(100, (limit.used / limit.amount) * 100)}
              aria-label={usage(limit)}
            />
          </ListRow>
        ))}
      </ListCard>
    </Section>
  );
}
