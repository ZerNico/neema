import { Clock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useState } from "react";
import {
  type ClockTime,
  LAST_DAY,
  clockText,
  inOrder,
  monthDaysText,
  ordinal,
} from "../cadence.ts";
import { ListRow } from "~/ui/page-shell.tsx";
import { Button } from "~/ui/primitives/button";
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

const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);

const parseClock = (value: string): ClockTime | null => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
};

export function OptionSelect({
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

/**
 * shadcn's time picker is the native input with the browser's indicator
 * hidden; our own clock sits in an addon so it matches the other icons.
 */
export function TimeInput({
  time,
  onChange,
}: {
  time: ClockTime;
  onChange: (time: ClockTime) => void;
}) {
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

/**
 * Five-minute steps read better than a bare number; an odd minute a model
 * chose stays listed so the select can still show it.
 */
export function MinuteSelect({
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
export function Joiner({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground text-sm">{children}</span>;
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ListRow>
      <span className="min-w-0 flex-1 text-sm font-medium">{label}</span>
      {children}
    </ListRow>
  );
}

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

export function MonthDaysPicker({
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
