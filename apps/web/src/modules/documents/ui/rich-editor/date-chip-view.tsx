import { m } from "~/paraglide/messages.js";
import { formatLocale } from "~/i18n/formats.ts";
import { Calendar03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { Suspense, lazy, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "~/ui/primitives/popover";
import { cn } from "~/ui/utils";
import { isoDay } from "./dates.ts";

// The calendar loads when a chip is first opened, not with the editor.
const Calendar = lazy(() =>
  import("~/ui/primitives/calendar").then((module) => ({ default: module.Calendar })),
);

const parseDay = (value: string) => {
  const day = new Date(`${value}T00:00:00`);
  return Number.isNaN(day.getTime()) ? null : day;
};

/** A date chip: the date, and a calendar to change it for anyone who may edit. */
export function DateChipView({ node, updateAttributes, editor, selected }: ReactNodeViewProps) {
  const [open, setOpen] = useState(false);
  const day = parseDay(String(node.attrs.value ?? ""));
  const label = day
    ? day.toLocaleDateString(formatLocale(), { day: "numeric", month: "short", year: "numeric" })
    : m.documents_date_none();
  return (
    <NodeViewWrapper as="span" className="inline-block align-baseline">
      <Popover open={open && editor.isEditable} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              contentEditable={false}
              aria-label={m.documents_date_label({ date: label })}
              className={cn(
                "bg-muted text-foreground inline-flex items-center gap-1 rounded-md px-1.5 align-baseline text-[0.9em] leading-snug font-medium",
                selected && "ring-ring/50 ring-2",
              )}
            />
          }
        >
          <HugeiconsIcon
            icon={Calendar03Icon}
            strokeWidth={2}
            className="text-muted-foreground size-3.5"
          />
          {label}
        </PopoverTrigger>
        <PopoverContent align="start">
          <Suspense fallback={null}>
            <Calendar
              mode="single"
              selected={day ?? undefined}
              {...(day ? { defaultMonth: day } : {})}
              onSelect={(next) => {
                if (!next) return;
                updateAttributes({ value: isoDay(next) });
                setOpen(false);
              }}
            />
          </Suspense>
        </PopoverContent>
      </Popover>
    </NodeViewWrapper>
  );
}
