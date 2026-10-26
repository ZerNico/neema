import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-form";
import { useState } from "react";
import {
  type Cadence,
  DEFAULT_CADENCE,
  HOUR_STEPS,
  inOrder,
  MONTH_STEPS,
  cadenceCron,
  cadenceText,
  isPreset,
  monthName,
  parseCadence,
  weekdayName,
  withKind,
} from "../cadence.ts";
import { EMPTY_SCHEDULE_DRAFT } from "../draft-schema.ts";
import { previewSchedule } from "../server/functions.ts";
import { withForm } from "~/ui/form/app-form.ts";
import { ListCard, ListRow } from "~/ui/page-shell.tsx";
import { Button } from "~/ui/primitives/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "~/ui/primitives/combobox";
import { FieldLabel } from "~/ui/primitives/field";
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";
import { useDebounced } from "~/ui/use-debounced.ts";
import { m } from "~/paraglide/messages.js";
import { formatLocale } from "~/i18n/formats.ts";
import {
  Joiner,
  MinuteSelect,
  MonthDaysPicker,
  OptionSelect,
  Row,
  TimeInput,
} from "./schedule-timing-controls.tsx";

const TIMEZONES: ReadonlyArray<string> = (() => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
})();

type PresetKind = "hourly" | "daily" | "weekdays" | "weekly" | "monthly";
type CustomKind = "hourly" | "daily" | "weekly" | "monthly" | "yearly";

// Built per render: the labels are messages, read in the page's language.
const presets = (): ReadonlyArray<{ value: PresetKind | "custom"; label: string }> => [
  { value: "hourly", label: m.schedules_timing_hourly() },
  { value: "daily", label: m.schedules_timing_daily() },
  { value: "weekdays", label: m.schedules_timing_weekdays() },
  { value: "weekly", label: m.schedules_timing_weekly() },
  { value: "monthly", label: m.schedules_timing_monthly() },
  { value: "custom", label: m.schedules_timing_custom() },
];

const repeats = (): ReadonlyArray<{ value: CustomKind; label: string }> => [
  { value: "hourly", label: m.schedules_timing_hourly() },
  { value: "daily", label: m.schedules_timing_daily() },
  { value: "weekly", label: m.schedules_timing_weekly() },
  { value: "monthly", label: m.schedules_timing_monthly() },
  { value: "yearly", label: m.schedules_timing_yearly() },
];

// Monday first, the way a week reads on a calendar; values are cron weekdays.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const weekdayOptions = () =>
  WEEK_ORDER.map((day) => ({ value: String(day), label: weekdayName(day) }));
const monthOptions = () =>
  Array.from({ length: 12 }, (_, index) => ({
    value: String(index + 1),
    label: monthName(index + 1),
  }));
const hourStepOptions = () =>
  HOUR_STEPS.map((count) => ({ value: String(count), label: m.schedules_timing_hours({ count }) }));
const monthStepOptions = () =>
  MONTH_STEPS.map((count) => ({
    value: String(count),
    label: m.schedules_timing_months({ count }),
  }));

/** Picker depth, simplest first; a cadence never shows shallower than it needs. */
type Mode = "preset" | "custom" | "cron";
const DEPTH: Record<Mode, number> = { preset: 0, custom: 1, cron: 2 };

const PREVIEW_COUNT = 3;

/** Fires are shown in the schedule's zone, which is the one the cadence means. */
const fireLabel = (fire: string, timezone: string) => {
  try {
    return new Intl.DateTimeFormat(formatLocale(), {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone,
    }).format(new Date(fire));
  } catch {
    return new Date(fire).toLocaleString(formatLocale());
  }
};

const previewError = (error: unknown) =>
  error instanceof Error && error.message ? error.message : m.schedules_timing_invalid();

const nextRunsText = (fires: string[] | undefined, cron: string, timezone: string) => {
  if (!cron) return m.schedules_timing_choose_frequency();
  if (!fires) return m.schedules_timing_next_loading();
  if (fires.length === 0) return m.schedules_timing_next_none();
  return m.schedules_timing_next_list({
    runs: fires
      .slice(0, PREVIEW_COUNT)
      .map((fire) => fireLabel(fire, timezone))
      .join(", "),
  });
};

// A selection that empties would never fire, so the last day stays pressed.
const keepOne = (values: string[], apply: (days: number[]) => void) => {
  if (values.length > 0) apply(inOrder(values.map(Number)));
};

/**
 * One control for when a schedule fires. Presets and the Custom card write
 * both the cron and its description, so the two cannot disagree. Neither is
 * edited directly; a model-written cron the picker cannot read is shown as is.
 */
export const ScheduleTimingFields = withForm({
  defaultValues: EMPTY_SCHEDULE_DRAFT,
  render: function ScheduleTimingFields({ form }) {
    const cron = useStore(form.store, (state) => state.values.cron);
    const scheduleText = useStore(form.store, (state) => state.values.scheduleText);
    const timezone = useStore(form.store, (state) => state.values.timezone);
    const endAt = useStore(form.store, (state) => state.values.endAt);
    const cadence = parseCadence(cron);
    const natural: Mode =
      cadence.kind === "cron" ? "cron" : isPreset(cadence) ? "preset" : "custom";
    // A deeper choice sticks (Custom stays Custom for a cron a preset could
    // show); a cadence that needs more depth than chosen always gets it.
    const [chosen, setChosen] = useState<Exclude<Mode, "cron"> | null>(null);
    const mode = chosen && DEPTH[chosen] > DEPTH[natural] ? chosen : natural;
    const apply = (next: Cadence) => {
      form.setFieldValue("cron", cadenceCron(next));
      const text = cadenceText(next);
      if (text) form.setFieldValue("scheduleText", text);
    };
    // The Custom card has no Weekdays; it is Weekly with Monday to Friday.
    const view: Cadence = cadence.kind === "weekdays" ? withKind(cadence, "weekly") : cadence;

    const settledCron = useDebounced(cron.trim(), 300);
    const preview = useQuery({
      queryKey: ["schedule-preview", settledCron, timezone, endAt],
      queryFn: () => previewSchedule({ data: { cron: settledCron, timezone, endAt } }),
      enabled: settledCron.split(/\s+/).length === 5,
      placeholderData: keepPreviousData,
      retry: false,
      staleTime: 60_000,
    });

    return (
      <div className="flex flex-col gap-3">
        <FieldLabel>{m.schedules_timing_frequency()}</FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          <OptionSelect
            label={m.schedules_timing_frequency()}
            items={presets()}
            className="w-36"
            value={mode === "preset" ? cadence.kind : "custom"}
            onChange={(value) => {
              if (value === "custom") {
                // A cron the picker cannot read starts the card from a default.
                if (cadence.kind === "cron") apply(DEFAULT_CADENCE);
                setChosen("custom");
                return;
              }
              setChosen("preset");
              apply(withKind(cadence, value as PresetKind, true));
            }}
          />
          {mode === "preset" && cadence.kind === "weekly" ? (
            <>
              <Joiner>{m.schedules_timing_joiner_on_weekday()}</Joiner>
              <OptionSelect
                label={m.schedules_timing_day_of_week()}
                items={weekdayOptions()}
                className="w-36"
                value={String(cadence.days[0])}
                onChange={(day) => apply({ ...cadence, days: [Number(day)] })}
              />
            </>
          ) : null}
          {mode === "preset" && cadence.kind === "monthly" ? (
            <>
              <Joiner>{m.schedules_timing_joiner_on_month_day()}</Joiner>
              <MonthDaysPicker
                days={cadence.days}
                onChange={(days) => apply({ ...cadence, days })}
              />
            </>
          ) : null}
          {mode === "preset" && cadence.kind === "hourly" ? (
            <>
              <Joiner>{m.schedules_timing_joiner_at()}</Joiner>
              <MinuteSelect
                minute={cadence.minute}
                onChange={(minute) => apply({ ...cadence, minute })}
              />
            </>
          ) : null}
          {mode === "preset" && "time" in cadence ? (
            <>
              <Joiner>{m.schedules_timing_joiner_at()}</Joiner>
              <TimeInput time={cadence.time} onChange={(time) => apply({ ...cadence, time })} />
            </>
          ) : null}
        </div>

        {mode === "custom" && view.kind !== "cron" && view.kind !== "weekdays" ? (
          <div className="flex flex-col gap-2">
            <ListCard>
              <Row label={m.schedules_timing_repeats()}>
                <OptionSelect
                  label={m.schedules_timing_repeats()}
                  items={repeats()}
                  className="w-36"
                  value={view.kind}
                  onChange={(kind) => apply(withKind(view, kind as CustomKind))}
                />
              </Row>
              {view.kind === "hourly" ? (
                <>
                  <Row label={m.schedules_timing_every()}>
                    <OptionSelect
                      label={m.schedules_timing_every()}
                      items={hourStepOptions()}
                      className="w-36"
                      value={String(view.every)}
                      onChange={(every) => apply({ ...view, every: Number(every) })}
                    />
                  </Row>
                  <Row label={m.schedules_timing_at()}>
                    <MinuteSelect
                      minute={view.minute}
                      onChange={(minute) => apply({ ...view, minute })}
                    />
                  </Row>
                </>
              ) : null}
              {view.kind === "monthly" ? (
                <Row label={m.schedules_timing_every()}>
                  <OptionSelect
                    label={m.schedules_timing_every()}
                    items={monthStepOptions()}
                    className="w-36"
                    value={String(view.every)}
                    onChange={(every) => apply({ ...view, every: Number(every) })}
                  />
                </Row>
              ) : null}
              {view.kind === "weekly" ? (
                <Row label={m.schedules_timing_on()}>
                  <ToggleGroup
                    multiple
                    spacing={1}
                    aria-label={m.schedules_timing_days_of_week()}
                    value={view.days.map(String)}
                    onValueChange={(values: string[]) =>
                      keepOne(values, (days) => apply({ ...view, days }))
                    }
                  >
                    {WEEK_ORDER.map((day) => (
                      <ToggleGroupItem
                        key={day}
                        value={String(day)}
                        variant="solid"
                        size="sm"
                        aria-label={weekdayName(day)}
                      >
                        {weekdayName(day).slice(0, 2)}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Row>
              ) : null}
              {view.kind === "yearly" ? (
                <Row label={m.schedules_timing_in()}>
                  <OptionSelect
                    label={m.schedules_timing_month()}
                    items={monthOptions()}
                    className="w-36"
                    value={String(view.month)}
                    onChange={(month) => apply({ ...view, month: Number(month) })}
                  />
                </Row>
              ) : null}
              {view.kind === "monthly" || view.kind === "yearly" ? (
                <Row label={m.schedules_timing_on_days()}>
                  <MonthDaysPicker
                    multiple
                    days={view.days}
                    onChange={(days) => apply({ ...view, days })}
                  />
                </Row>
              ) : null}
              {"time" in view ? (
                <Row label={m.schedules_timing_at()}>
                  <TimeInput time={view.time} onChange={(time) => apply({ ...view, time })} />
                </Row>
              ) : null}
            </ListCard>
          </div>
        ) : null}

        {mode === "cron" ? (
          // Only the model writes a cron the picker cannot read; it stays as
          // written until the user replaces it here.
          <ListCard>
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">
                  {scheduleText || m.schedules_timing_no_frequency()}
                </span>
                <span className="text-muted-foreground text-xs">
                  {m.schedules_timing_cron_hint()}
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  apply(DEFAULT_CADENCE);
                  setChosen(null);
                }}
              >
                {m.schedules_timing_change()}
              </Button>
            </ListRow>
          </ListCard>
        ) : null}

        <div className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
          <span>
            {preview.isError
              ? previewError(preview.error)
              : nextRunsText(preview.data, settledCron, timezone)}
          </span>
          <span aria-hidden>·</span>
          <form.Field name="timezone">
            {(field) => (
              <Combobox
                items={[...TIMEZONES]}
                value={field.state.value}
                onValueChange={(value: string | null) => {
                  if (value) field.handleChange(value);
                }}
              >
                <ComboboxTrigger
                  aria-label={m.schedules_timing_timezone({ timezone: field.state.value })}
                  render={<Button variant="ghost" size="xs" />}
                >
                  {field.state.value}
                </ComboboxTrigger>
                <ComboboxContent align="start" className="w-72">
                  <ComboboxInput
                    placeholder={m.schedules_timing_timezone_search()}
                    showTrigger={false}
                  />
                  <ComboboxEmpty>{m.schedules_timing_timezone_empty()}</ComboboxEmpty>
                  <ComboboxList>
                    {(zone: string) => (
                      <ComboboxItem key={zone} value={zone}>
                        {zone}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
            )}
          </form.Field>
        </div>
      </div>
    );
  },
});
