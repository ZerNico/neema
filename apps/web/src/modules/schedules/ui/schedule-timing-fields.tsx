import { Clock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-form";
import { type ReactNode, useState } from "react";
import {
  type Cadence,
  type ClockTime,
  DEFAULT_CADENCE,
  HOUR_STEPS,
  inOrder,
  LAST_DAY,
  MONTH_NAMES,
  MONTH_STEPS,
  WEEKDAY_NAMES,
  cadenceCron,
  cadenceText,
  clockText,
  isPreset,
  monthDaysText,
  ordinal,
  parseCadence,
  withKind,
} from "../cadence.ts";
import { EMPTY_SCHEDULE_DRAFT } from "../draft-schema.ts";
import { previewSchedule } from "../server/functions.ts";
import { withForm } from "~/ui/form/app-form.tsx";
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/ui/primitives/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "~/ui/primitives/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";
import { useDebounced } from "~/ui/use-debounced.ts";

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
const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);
const stepOptions = (steps: ReadonlyArray<number>, unit: string) =>
  steps.map((n) => ({ value: String(n), label: n === 1 ? `1 ${unit}` : `${n} ${unit}s` }));
const HOUR_STEP_OPTIONS = stepOptions(HOUR_STEPS, "hour");
const MONTH_STEP_OPTIONS = stepOptions(MONTH_STEPS, "month");

/** Picker depth, simplest first; a cadence never shows shallower than it needs. */
type Mode = "preset" | "custom" | "cron";
const DEPTH: Record<Mode, number> = { preset: 0, custom: 1, cron: 2 };

const PREVIEW_COUNT = 3;

const parseClock = (value: string): ClockTime | null => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
};

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

function OptionSelect({
  label,
  items,
  value,
  onChange,
  className,
}: {
  label: string;
  items: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next: string | null) => {
        if (next) onChange(next);
      }}
    >
      <SelectTrigger aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// shadcn's time picker is the native input with the browser's indicator
// hidden; our own clock sits in an addon so it matches the other icons.
function TimeInput({ time, onChange }: { time: ClockTime; onChange: (time: ClockTime) => void }) {
  return (
    <InputGroup className="w-32">
      <InputGroupAddon>
        <HugeiconsIcon icon={Clock01Icon} strokeWidth={2} aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        aria-label="Time"
        type="time"
        className="appearance-none [&::-webkit-calendar-picker-indicator]:hidden"
        value={clockText(time)}
        onChange={(event) => {
          const next = parseClock(event.target.value);
          if (next) onChange(next);
        }}
      />
    </InputGroup>
  );
}

// Five-minute steps read better than a bare number; an odd minute a model
// chose stays listed so the select can still show it.
function MinuteSelect({
  minute,
  onChange,
}: {
  minute: number;
  onChange: (minute: number) => void;
}) {
  const items = Array.from({ length: 60 }, (_, value) => value)
    .filter((value) => value % 5 === 0 || value === minute)
    .map((value) => ({ value: String(value), label: `:${String(value).padStart(2, "0")}` }));
  return (
    <OptionSelect
      label="Minutes past the hour"
      items={items}
      className="w-24"
      value={String(minute)}
      onChange={(value) => onChange(Number(value))}
    />
  );
}

/** A connecting word, so the controls read as one sentence. */
function Joiner({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground text-sm">{children}</span>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ListRow>
      <span className="min-w-0 flex-1 text-sm font-medium">{label}</span>
      {children}
    </ListRow>
  );
}

// A selection that empties would never fire, so the last day stays pressed.
const keepOne = (values: string[], apply: (days: number[]) => void) => {
  if (values.length > 0) apply(inOrder(values.map(Number)));
};

// Past three names the label would grow with every pick and push the
// popover around, so longer selections are counted instead.
const daysSummary = (days: ReadonlyArray<number>) =>
  days.length <= 3 ? monthDaysText(days) : `${days.length} days`;

const SHORT_MONTH_DAYS = new Set([29, 30, 31]);

const shortMonthHint = (days: ReadonlyArray<number>) => {
  const short = days.filter((day) => SHORT_MONTH_DAYS.has(day));
  const skip = `Months without the ${monthDaysText(short)} skip ${short.length === 1 ? "it" : "them"}.`;
  return days.includes(LAST_DAY) ? skip : `${skip} Choose Last day to run every month.`;
};

function MonthDaysPicker({
  days,
  multiple = false,
  onChange,
}: {
  days: ReadonlyArray<number>;
  multiple?: boolean;
  onChange: (days: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = multiple ? "Days of the month" : "Day of the month";
  const shortMonthDays = days.filter((day) => SHORT_MONTH_DAYS.has(day));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button type="button" variant="outline" aria-label={label} />}>
        {daysSummary(days)}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto">
        <ToggleGroup
          multiple={multiple}
          spacing={1}
          aria-label={label}
          className="grid grid-cols-7"
          value={days.map(String)}
          onValueChange={(values: string[]) => {
            if (values.length === 0) return;
            onChange(inOrder(values.map(Number)));
            if (!multiple) setOpen(false);
          }}
        >
          {MONTH_DAYS.map((day) => (
            <ToggleGroupItem
              key={day}
              value={String(day)}
              variant="solid"
              size="icon"
              aria-label={ordinal(day)}
            >
              {day}
            </ToggleGroupItem>
          ))}
          {/* Fills the four cells after the 31st. */}
          <ToggleGroupItem
            value={String(LAST_DAY)}
            variant="solid"
            size="sm"
            className="col-span-4"
          >
            Last day
          </ToggleGroupItem>
        </ToggleGroup>
        {shortMonthDays.length > 0 ? (
          <p className="text-muted-foreground max-w-60 pt-2 text-xs">{shortMonthHint(days)}</p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

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
