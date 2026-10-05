import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-form";
import { useState } from "react";
import {
  type Cadence,
  DEFAULT_CADENCE,
  HOUR_STEPS,
  inOrder,
  MONTH_NAMES,
  MONTH_STEPS,
  WEEKDAY_NAMES,
  cadenceCron,
  cadenceText,
  isPreset,
  parseCadence,
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

const PRESETS: ReadonlyArray<{ value: PresetKind | "custom"; label: string }> = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "custom", label: "Custom" },
];

const REPEATS: ReadonlyArray<{ value: CustomKind; label: string }> = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
];

// Monday first, the way a week reads on a calendar; values are cron weekdays.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_OPTIONS = WEEK_ORDER.map((day) => ({
  value: String(day),
  label: WEEKDAY_NAMES[day],
}));
const MONTH_OPTIONS = MONTH_NAMES.map((name, index) => ({ value: String(index + 1), label: name }));
const stepOptions = (steps: ReadonlyArray<number>, unit: string) =>
  steps.map((n) => ({ value: String(n), label: n === 1 ? `1 ${unit}` : `${n} ${unit}s` }));
const HOUR_STEP_OPTIONS = stepOptions(HOUR_STEPS, "hour");
const MONTH_STEP_OPTIONS = stepOptions(MONTH_STEPS, "month");

/** Picker depth, simplest first; a cadence never shows shallower than it needs. */
type Mode = "preset" | "custom" | "cron";
const DEPTH: Record<Mode, number> = { preset: 0, custom: 1, cron: 2 };

const PREVIEW_COUNT = 3;

/** Fires are shown in the schedule's zone, which is the one the cadence means. */
const fireLabel = (fire: string, timezone: string) => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone,
    }).format(new Date(fire));
  } catch {
    return new Date(fire).toLocaleString();
  }
};

const previewError = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "This schedule is not valid.";

const nextRunsText = (fires: string[] | undefined, cron: string, timezone: string) => {
  if (!cron) return "Choose a frequency to see when it runs";
  if (!fires) return "Next runs…";
  if (fires.length === 0) return "No upcoming runs";
  return `Next: ${fires
    .slice(0, PREVIEW_COUNT)
    .map((fire) => fireLabel(fire, timezone))
    .join(", ")}`;
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
        <FieldLabel>Frequency</FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          <OptionSelect
            label="Frequency"
            items={PRESETS}
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
              <Joiner>on</Joiner>
              <OptionSelect
                label="Day of the week"
                items={WEEKDAY_OPTIONS}
                className="w-36"
                value={String(cadence.days[0])}
                onChange={(day) => apply({ ...cadence, days: [Number(day)] })}
              />
            </>
          ) : null}
          {mode === "preset" && cadence.kind === "monthly" ? (
            <>
              <Joiner>on the</Joiner>
              <MonthDaysPicker
                days={cadence.days}
                onChange={(days) => apply({ ...cadence, days })}
              />
            </>
          ) : null}
          {mode === "preset" && cadence.kind === "hourly" ? (
            <>
              <Joiner>at</Joiner>
              <MinuteSelect
                minute={cadence.minute}
                onChange={(minute) => apply({ ...cadence, minute })}
              />
            </>
          ) : null}
          {mode === "preset" && "time" in cadence ? (
            <>
              <Joiner>at</Joiner>
              <TimeInput time={cadence.time} onChange={(time) => apply({ ...cadence, time })} />
            </>
          ) : null}
        </div>

        {mode === "custom" && view.kind !== "cron" && view.kind !== "weekdays" ? (
          <div className="flex flex-col gap-2">
            <ListCard>
              <Row label="Repeats">
                <OptionSelect
                  label="Repeats"
                  items={REPEATS}
                  className="w-36"
                  value={view.kind}
                  onChange={(kind) => apply(withKind(view, kind as CustomKind))}
                />
              </Row>
              {view.kind === "hourly" ? (
                <>
                  <Row label="Every">
                    <OptionSelect
                      label="Every"
                      items={HOUR_STEP_OPTIONS}
                      className="w-36"
                      value={String(view.every)}
                      onChange={(every) => apply({ ...view, every: Number(every) })}
                    />
                  </Row>
                  <Row label="At">
                    <MinuteSelect
                      minute={view.minute}
                      onChange={(minute) => apply({ ...view, minute })}
                    />
                  </Row>
                </>
              ) : null}
              {view.kind === "monthly" ? (
                <Row label="Every">
                  <OptionSelect
                    label="Every"
                    items={MONTH_STEP_OPTIONS}
                    className="w-36"
                    value={String(view.every)}
                    onChange={(every) => apply({ ...view, every: Number(every) })}
                  />
                </Row>
              ) : null}
              {view.kind === "weekly" ? (
                <Row label="On">
                  <ToggleGroup
                    multiple
                    spacing={1}
                    aria-label="Days of the week"
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
                        aria-label={WEEKDAY_NAMES[day]}
                      >
                        {WEEKDAY_NAMES[day].slice(0, 2)}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Row>
              ) : null}
              {view.kind === "yearly" ? (
                <Row label="In">
                  <OptionSelect
                    label="Month"
                    items={MONTH_OPTIONS}
                    className="w-36"
                    value={String(view.month)}
                    onChange={(month) => apply({ ...view, month: Number(month) })}
                  />
                </Row>
              ) : null}
              {view.kind === "monthly" || view.kind === "yearly" ? (
                <Row label="On days">
                  <MonthDaysPicker
                    multiple
                    days={view.days}
                    onChange={(days) => apply({ ...view, days })}
                  />
                </Row>
              ) : null}
              {"time" in view ? (
                <Row label="At">
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
                  {scheduleText || "No frequency yet"}
                </span>
                <span className="text-muted-foreground text-xs">
                  Set in chat. The picker can’t show this frequency.
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
                Change
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
                  aria-label={`Timezone, ${field.state.value}`}
                  render={<Button variant="ghost" size="xs" />}
                >
                  {field.state.value}
                </ComboboxTrigger>
                <ComboboxContent align="start" className="w-72">
                  <ComboboxInput placeholder="Search timezones…" showTrigger={false} />
                  <ComboboxEmpty>No matching timezone</ComboboxEmpty>
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
