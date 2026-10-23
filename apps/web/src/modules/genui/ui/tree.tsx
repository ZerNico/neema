// Draws a validated tree with the app's own components. Props arrive already
// checked against the catalog, so each component only maps them onto ours;
// anything it does not recognise renders nothing rather than guessing.

import katex from "katex";
import {
  Suspense,
  createContext,
  lazy,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Calendar03Icon,
  Cancel01Icon,
  Copy01Icon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { MotionSwap } from "~/ui/motion.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "~/ui/card.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Checkbox } from "~/ui/primitives/checkbox";
import { Input } from "~/ui/primitives/input";
import { Label } from "~/ui/primitives/label";
import { Popover, PopoverContent, PopoverTrigger } from "~/ui/primitives/popover";
import { Progress, ProgressLabel } from "~/ui/primitives/progress";
import { RadioGroup, RadioGroupItem } from "~/ui/primitives/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { Separator } from "~/ui/primitives/separator";
import { Slider } from "~/ui/primitives/slider";
import { Switch } from "~/ui/primitives/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/primitives/tabs";
import { Textarea } from "~/ui/primitives/textarea";
import { SegmentedControl, SegmentedControlItem } from "~/ui/segmented-control.tsx";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "~/ui/disclosure.tsx";
import { disclosureTriggerClassName } from "~/ui/disclosure-classes.ts";
import { focusRingClassName } from "~/ui/focus-ring.ts";
import { useAppReducedMotion } from "~/ui/reduced-motion.ts";
import { cn } from "~/ui/utils";
import type { ValidNode } from "../catalog.ts";
import { Celebrate } from "./celebrate.tsx";
import { UiChart, UiProgress, UiSvg, UiTable } from "./data.tsx";
import { iconOf } from "./icons.ts";
import { handlerOf, useHandler } from "./handler.ts";
import { UiLink } from "./link.tsx";
import { UiMap } from "./map.tsx";
import { UiImage, UiImages } from "./media.tsx";
import { copiedPreview } from "../text.ts";
import { formatNumber } from "./format.ts";
import { BlockKeyContext, SuggestContext } from "./context.ts";

type Child = ValidNode | string;

// Tailwind only ships classes it can see, so every step is spelled out.
const GAP = [
  "gap-0",
  "gap-1",
  "gap-2",
  "gap-3",
  "gap-4",
  "gap-5",
  "gap-6",
  "gap-7",
  "gap-8",
  "gap-9",
  "gap-10",
  "gap-11",
  "gap-12",
];
const PAD = [
  "p-0",
  "p-1",
  "p-2",
  "p-3",
  "p-4",
  "p-5",
  "p-6",
  "p-7",
  "p-8",
  "p-9",
  "p-10",
  "p-11",
  "p-12",
];
const COLS = [
  "",
  "sm:grid-cols-1",
  "sm:grid-cols-2",
  "sm:grid-cols-3",
  "sm:grid-cols-4",
  "sm:grid-cols-5",
  "sm:grid-cols-6",
];
const SPAN = [
  "",
  "sm:col-span-1",
  "sm:col-span-2",
  "sm:col-span-3",
  "sm:col-span-4",
  "sm:col-span-5",
  "sm:col-span-6",
];
const ALIGN: Record<string, string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
  baseline: "items-baseline",
};
const JUSTIFY: Record<string, string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  between: "justify-between",
};
const TONE: Record<string, string> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
};
const CALLOUT: Record<string, string> = {
  info: "border-border bg-muted/50",
  success: "border-success/30 bg-success/10",
  warning: "border-warning/30 bg-warning/10",
  destructive: "border-destructive/30 bg-destructive/10",
};
const TEXT_SIZE: Record<string, string> = { sm: "text-xs", md: "text-sm", lg: "text-base" };
const TITLE_SIZE: Record<string, string> = { sm: "text-sm", md: "text-base", lg: "text-lg" };

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
const step = (value: unknown, table: readonly string[], fallback: number) =>
  table[num(value) ?? fallback] ?? "";

function optionsOf(value: unknown): { label: string; value: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((o: unknown) => {
    if (typeof o === "string") return [{ label: o, value: o }];
    if (typeof o === "object" && o !== null && "label" in o && "value" in o) {
      const { label, value: v } = o;
      return typeof label === "string" && typeof v === "string" ? [{ label, value: v }] : [];
    }
    return [];
  });
}

/** A control's own value while the reader moves it, until the tree's value changes. */
/** A node's place in its block's tree, for state that outlives a remount. */
const PathContext = createContext("");

function useLocal<T>(value: T): [T, (next: T) => void] {
  const [local, setLocal] = useState<{ value: T; base: T } | null>(null);
  const shown = local !== null && Object.is(local.base, value) ? local.value : value;
  return [shown, (next) => setLocal({ value: next, base: value })];
}

function Field({ label, children }: { label: string | undefined; children: ReactNode }) {
  if (!label) return children;
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function formatDate(value: unknown, format: string | undefined): string {
  const date = new Date(
    typeof value === "number" || typeof value === "string" ? value : Number.NaN,
  );
  if (Number.isNaN(date.getTime())) return "";
  const locale = typeof navigator === "undefined" ? undefined : navigator.language;
  if (format === "relative") {
    const days = Math.round((date.getTime() - Date.now()) / 86_400_000);
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day");
  }
  const options: Intl.DateTimeFormatOptions =
    format === "time"
      ? { timeStyle: "short" }
      : format === "datetime"
        ? { dateStyle: "medium", timeStyle: "short" }
        : { dateStyle: "medium" };
  return new Intl.DateTimeFormat(locale, options).format(date);
}

function SliderNode({ node }: { node: ValidNode }) {
  const p = node.props;
  const fire = useHandler(handlerOf(p.onchange), { event: "change", tag: "slider" });
  const [value, setValue] = useLocal(num(p.value) ?? 0);
  const min = num(p.min) ?? 0;
  const max = num(p.max) ?? 100;
  return (
    <Field label={str(p.label)}>
      <div className="flex items-center gap-3">
        <Slider
          min={min}
          max={max}
          step={num(p.step) ?? 1}
          // An array: shadcn's Slider counts thumbs from it, and a bare number
          // renders a second thumb that swallows every press on the track.
          value={[value]}
          disabled={!fire}
          aria-label={str(p.label) ?? "Value"}
          onValueChange={(next) => {
            const v = Array.isArray(next) ? next[0] : next;
            if (typeof v !== "number") return;
            setValue(v);
            fire?.([v]);
          }}
        />
        <span className="text-muted-foreground w-12 text-right text-xs tabular-nums">{value}</span>
      </div>
    </Field>
  );
}

function TextInputNode({ node, numeric }: { node: ValidNode; numeric: boolean }) {
  const p = node.props;
  const fire = useHandler(handlerOf(p.onchange), { event: "change", tag: node.tag });
  const initial = numeric ? String(num(p.value) ?? "") : (str(p.value) ?? "");
  const [value, setValue] = useLocal(initial);
  const label = str(p.label) ?? str(p.placeholder) ?? "Input";
  if (!numeric && p.multiline === true)
    return (
      <Field label={str(p.label)}>
        <Textarea
          value={value}
          placeholder={str(p.placeholder)}
          readOnly={!fire}
          aria-label={label}
          onChange={(event) => {
            setValue(event.target.value);
            fire?.([event.target.value]);
          }}
        />
      </Field>
    );
  return (
    <Field label={str(p.label)}>
      <Input
        type={numeric ? "number" : "text"}
        value={value}
        placeholder={str(p.placeholder)}
        min={num(p.min)}
        max={num(p.max)}
        step={num(p.step)}
        readOnly={!fire}
        aria-label={label}
        onChange={(event) => {
          const raw = event.target.value;
          setValue(raw);
          if (!numeric) fire?.([raw]);
          else if (raw !== "" && Number.isFinite(Number(raw))) fire?.([Number(raw)]);
        }}
      />
    </Field>
  );
}

const Calendar = lazy(() =>
  import("~/ui/primitives/calendar").then((module) => ({ default: module.Calendar })),
);

const dayOf = (date: Date) =>
  `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/**
 * "2026-05-01" as that calendar day at local midnight, so no zone moves it to
 * the 30th. A day that does not exist ("2026-02-31") is no day, not 3 March.
 */
const parseDay = (value: unknown) => {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) return undefined;
  const day = new Date(2000, 0, 1);
  // setFullYear, since the constructor reads years below 100 as 19xx.
  day.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return dayOf(day) === value ? day : undefined;
};

function DatePickerNode({ node }: { node: ValidNode }) {
  const p = node.props;
  const fire = useHandler(handlerOf(p.onchange), { event: "change", tag: "datepicker" });
  const [value, setValue] = useLocal(str(p.value));
  const [open, setOpen] = useState(false);
  const day = parseDay(value);
  const min = parseDay(p.min);
  const max = parseDay(p.max);
  const label = str(p.label);
  const locale = typeof navigator === "undefined" ? undefined : navigator.language;
  const shown = day
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(day)
    : "Pick a date";
  return (
    <Field label={label}>
      <Popover open={open && !!fire} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              className="w-fit"
              disabled={!fire}
              // Named with its date, so a screen reader hears what is picked.
              aria-label={`${label ?? "Date"}: ${shown}`}
            />
          }
        >
          <HugeiconsIcon
            icon={Calendar03Icon}
            strokeWidth={2}
            data-icon="inline-start"
            aria-hidden
          />
          {shown}
        </PopoverTrigger>
        <PopoverContent align="start">
          <Suspense fallback={null}>
            <Calendar
              mode="single"
              selected={day}
              {...(day ? { defaultMonth: day } : min ? { defaultMonth: min } : {})}
              {...(min ? { startMonth: min } : {})}
              {...(max ? { endMonth: max } : {})}
              disabled={[...(min ? [{ before: min }] : []), ...(max ? [{ after: max }] : [])]}
              onSelect={(next: Date | undefined) => {
                if (!next) return;
                const picked = dayOf(next);
                setValue(picked);
                setOpen(false);
                fire?.([picked]);
              }}
            />
          </Suspense>
        </PopoverContent>
      </Popover>
    </Field>
  );
}

/**
 * The content is portalled out of the block's root, so `reveal(anchor)`, which
 * looks only inside that root, cannot reach an anchor in it. That fails closed.
 */
function PopoverNode({ node }: { node: ValidNode }) {
  const variant = str(node.props.variant);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="sm"
            className="w-fit"
            variant={
              variant === "default" || variant === "secondary" || variant === "ghost"
                ? variant
                : "outline"
            }
          />
        }
      >
        {str(node.props.label)}
      </PopoverTrigger>
      <PopoverContent align="start">
        <Nodes nodes={node.children} />
      </PopoverContent>
    </Popover>
  );
}

function IconNode({ node }: { node: ValidNode }) {
  const icon = iconOf(node.props.name);
  if (!icon) return null;
  const label = str(node.props.label);
  return (
    <HugeiconsIcon
      icon={icon}
      strokeWidth={2}
      className={cn(
        "inline-block size-[1.1em] shrink-0 align-[-0.15em]",
        TONE[str(node.props.tone) ?? ""],
      )}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    />
  );
}

function StepperNode({ node }: { node: ValidNode }) {
  const p = node.props;
  const fire = useHandler(handlerOf(p.onchange), { event: "click", tag: "stepper" });
  const value = num(p.value) ?? 0;
  const delta = num(p.step) ?? 1;
  const min = num(p.min) ?? Number.NEGATIVE_INFINITY;
  const max = num(p.max) ?? Number.POSITIVE_INFINITY;
  const label = str(p.label);
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Decrease"
          disabled={!fire || value - delta < min}
          onClick={() => fire?.([value - delta])}
        >
          −
        </Button>
        <span className="min-w-8 text-center text-sm font-medium tabular-nums">{value}</span>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Increase"
          disabled={!fire || value + delta > max}
          onClick={() => fire?.([value + delta])}
        >
          +
        </Button>
      </div>
    </Field>
  );
}

function ToggleNode({ node }: { node: ValidNode }) {
  const p = node.props;
  const fire = useHandler(handlerOf(p.onchange), { event: "change", tag: node.tag });
  const [checked, setChecked] = useLocal(p.checked === true);
  const label = str(p.label);
  const onChange = (next: boolean) => {
    setChecked(next);
    fire?.([next]);
  };
  const control =
    node.tag === "switch" ? (
      <Switch
        checked={checked}
        disabled={!fire}
        aria-label={label ?? "Toggle"}
        onCheckedChange={onChange}
      />
    ) : (
      <Checkbox
        checked={checked}
        disabled={!fire}
        aria-label={label ?? "Check"}
        onCheckedChange={onChange}
      />
    );
  return label ? (
    <label className="flex items-center gap-2 text-sm">
      {control}
      {label}
    </label>
  ) : (
    control
  );
}

function SegmentedNode({ node }: { node: ValidNode }) {
  const p = node.props;
  const fire = useHandler(handlerOf(p.onchange), { event: "change", tag: "segmented" });
  const options = optionsOf(p.options);
  const [value, setValue] = useLocal(str(p.value) ?? "");
  return (
    <SegmentedControl
      aria-label="Options"
      multiple={false}
      value={[value]}
      disabled={!fire}
      onValueChange={(next) => {
        const chosen = next[0];
        if (typeof chosen !== "string" || chosen === value) return;
        setValue(chosen);
        fire?.([chosen]);
      }}
    >
      {options.map((o) => (
        <SegmentedControlItem key={o.value} value={o.value}>
          {o.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

function ChoiceNode({ node }: { node: ValidNode }) {
  const p = node.props;
  const fire = useHandler(handlerOf(p.onchange), { event: "change", tag: "choice" });
  const options = optionsOf(p.options);
  const [value, setValue] = useLocal(str(p.value) ?? null);
  const label = str(p.label);
  return (
    <Field label={label}>
      <RadioGroup
        value={value}
        disabled={!fire}
        aria-label={label ?? "Options"}
        onValueChange={(next) => {
          if (typeof next !== "string") return;
          setValue(next);
          fire?.([next]);
        }}
      >
        {options.map((o) => (
          <label key={o.value} className="flex cursor-pointer items-center gap-2 text-sm">
            {/* A radio is a span, which a wrapping label does not name. */}
            <RadioGroupItem value={o.value} aria-label={o.label} />
            {o.label}
          </label>
        ))}
      </RadioGroup>
    </Field>
  );
}

function SelectNode({ node }: { node: ValidNode }) {
  const p = node.props;
  const fire = useHandler(handlerOf(p.onchange), { event: "change", tag: "select" });
  const options = optionsOf(p.options);
  const [value, setValue] = useLocal(str(p.value) ?? null);
  return (
    <Field label={str(p.label)}>
      <Select
        value={value}
        items={options}
        disabled={!fire}
        onValueChange={(next) => {
          if (typeof next !== "string") return;
          setValue(next);
          fire?.([next]);
        }}
      >
        <SelectTrigger className="w-full" aria-label={str(p.label) ?? "Choose"}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** The text a node shows; a suggestion sends exactly what it displays. */
function textOf(children: readonly Child[]): string {
  return children.map((c) => (typeof c === "string" ? c : textOf(c.children))).join("");
}

function SuggestionNode({ node }: { node: ValidNode }) {
  return <SuggestionChip label={textOf(node.children)} />;
}

/** A chip whose label is the message it sends, under the host's sending rules. */
function SuggestionChip({ label }: { label: string }) {
  const suggest = use(SuggestContext);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={!suggest}
      onClick={() => suggest?.(label)}
      // oxlint-disable-next-line shadcn/no-restyle -- a chip's label is what one click sends, so it wraps rather than running out of view
      className="h-auto min-h-8 py-1.5 text-left whitespace-normal"
    >
      {label}
    </Button>
  );
}

function ButtonNode({ node }: { node: ValidNode }) {
  const p = node.props;
  const fire = useHandler(handlerOf(p.onclick), { event: "click", tag: "button" });
  const variant = str(p.variant);
  return (
    <Button
      size="sm"
      // A lone button in a column keeps its own width instead of stretching.
      className="w-fit"
      variant={
        variant === "secondary" || variant === "outline" || variant === "ghost"
          ? variant
          : "default"
      }
      disabled={!fire || p.disabled === true}
      onClick={() => fire?.([])}
    >
      <Nodes nodes={node.children} />
    </Button>
  );
}

const stepsOf = (node: ValidNode) =>
  node.children.flatMap((c) => (typeof c === "string" || c.tag !== "step" ? [] : [c]));

function StepHeading({ step, done }: { step: ValidNode; done?: boolean }) {
  const time = str(step.props.time);
  return (
    <div className="flex min-w-0 flex-col">
      {time ? <span className="text-muted-foreground text-xs tabular-nums">{time}</span> : null}
      <span className={cn("text-sm font-medium", done && "text-muted-foreground line-through")}>
        {str(step.props.title)}
      </span>
    </div>
  );
}

/** A timeline, or with `checkable` a checklist whose ticks the block can keep. */
function StepsNode({ node }: { node: ValidNode }) {
  const p = node.props;
  const steps = stepsOf(node);
  const checkable = p.checkable === true;
  const fire = useHandler(handlerOf(p.onchange), { event: "change", tag: "steps" });
  // Compared as text: the tree hands over a new array on every render, and
  // the local ticks must survive until the block's own value changes.
  const given = JSON.stringify(
    Array.isArray(p.done) ? p.done.filter((i): i is number => typeof i === "number") : [],
  );
  const [doneText, setDoneText] = useLocal(given);
  const done: number[] = JSON.parse(doneText);
  const toggle = (index: number, checked: boolean) => {
    const next = checked
      ? [...done.filter((i) => i !== index), index].toSorted((a, b) => a - b)
      : done.filter((i) => i !== index);
    setDoneText(JSON.stringify(next));
    fire?.([next]);
  };
  return (
    <div className="flex flex-col gap-3">
      {checkable ? (
        <Progress value={(done.length / Math.max(1, steps.length)) * 100}>
          <ProgressLabel>
            {done.length} of {steps.length} done
          </ProgressLabel>
        </Progress>
      ) : null}
      <ol className="flex flex-col">
        {steps.map((step, i) => {
          const finished = done.includes(i);
          return (
            // oxlint-disable-next-line react/no-array-index-key -- steps have no identity beyond their order
            <li key={i} className="flex gap-3">
              <div className="flex flex-col items-center">
                {checkable ? (
                  <Checkbox
                    checked={finished}
                    onCheckedChange={(checked) => toggle(i, checked === true)}
                    aria-label={str(step.props.title) ?? `Step ${i + 1}`}
                  />
                ) : (
                  <span className="bg-primary mt-1.5 size-2 shrink-0 rounded-full" />
                )}
                {i < steps.length - 1 ? <span className="bg-border my-1 w-px flex-1" /> : null}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1 pb-4">
                <StepHeading step={step} done={checkable && finished} />
                <div className="text-sm">
                  <Nodes nodes={step.children} scope={i} />
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** One step at a time; the block may follow the position through onchange. */
function WizardNode({ node }: { node: ValidNode }) {
  const p = node.props;
  const steps = stepsOf(node);
  const fire = useHandler(handlerOf(p.onchange), { event: "change", tag: "wizard" });
  const [current, setCurrent] = useLocal(num(p.current) ?? 0);
  const index = Math.min(Math.max(0, current), Math.max(0, steps.length - 1));
  const step = steps[index];
  const go = (next: number) => {
    setCurrent(next);
    fire?.([next]);
  };
  if (!step) return null;
  return (
    <div className="flex flex-col gap-3">
      <Progress value={((index + 1) / steps.length) * 100}>
        <ProgressLabel>
          Step {index + 1} of {steps.length}
        </ProgressLabel>
      </Progress>
      <StepHeading step={step} />
      <div className="text-sm">
        <Nodes nodes={step.children} scope={index} />
      </div>
      <div className="flex justify-between gap-2">
        <Button size="sm" variant="outline" disabled={index === 0} onClick={() => go(index - 1)}>
          Back
        </Button>
        <Button size="sm" disabled={index === steps.length - 1} onClick={() => go(index + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

interface QuizQuestion {
  readonly prompt: readonly Child[];
  readonly options: readonly string[];
  readonly answer: string;
  readonly explain: string | undefined;
  /** Why each option is right or wrong, by option position. */
  readonly feedback: readonly (string | undefined)[];
  readonly hint: string | undefined;
}

function questionsOf(node: ValidNode): QuizQuestion[] {
  return node.children.flatMap((child) => {
    if (typeof child === "string" || child.tag !== "question") return [];
    const options = Array.isArray(child.props.options)
      ? child.props.options.filter((o): o is string => typeof o === "string")
      : [];
    const answer = str(child.props.answer) ?? "";
    // A question whose answer is not among its options cannot be scored.
    if (options.length < 2 || !options.includes(answer)) return [];
    const feedback = Array.isArray(child.props.feedback)
      ? options.map((_, i) => str((child.props.feedback as unknown[])[i]))
      : [];
    return [
      {
        prompt: child.children,
        options,
        answer,
        explain: str(child.props.explain),
        feedback,
        hint: str(child.props.hint),
      },
    ];
  });
}

const LETTERS = "ABCDEF";

/**
 * A quiz the page runs: one question at a time, scored as the reader goes.
 * The block may keep the answers in its state through answers and onchange.
 */
function QuizNode({ node }: { node: ValidNode }) {
  const p = node.props;
  const questions = questionsOf(node);
  const fire = useHandler(handlerOf(p.onchange), { event: "change", tag: "quiz" });
  // Compared as text: the tree hands over a new array on every render.
  const given = JSON.stringify(
    Array.isArray(p.answers) ? p.answers.map((a) => (typeof a === "string" ? a : null)) : [],
  );
  const [answersText, setAnswersText] = useLocal(given);
  const answers: (string | null)[] = JSON.parse(answersText);
  const firstOpen = questions.findIndex((_, i) => !answers[i]);
  const [index, setIndex] = useState(firstOpen === -1 ? 0 : firstOpen);
  const [scored, setScored] = useState(firstOpen === -1 && answers.length > 0);
  const [hinted, setHinted] = useState<number | null>(null);
  const title = str(p.title);
  const more = str(p.more);
  if (questions.length === 0) return null;
  const at = Math.min(index, questions.length - 1);
  const question = questions[at]!;
  const chosen = answers[at] ?? null;
  const record = (next: (string | null)[]) => {
    setAnswersText(JSON.stringify(next));
    fire?.([next]);
  };
  const pick = (option: string) => {
    if (chosen) return;
    const next = questions.map((_, i) => answers[i] ?? null);
    next[at] = option;
    record(next);
  };
  const score = questions.filter((q, i) => answers[i] === q.answer).length;
  const last = at === questions.length - 1;

  if (scored)
    return (
      <div className="border-border flex flex-col items-start gap-3 rounded-2xl border p-4">
        {title ? <span className="text-muted-foreground text-xs">{title}</span> : null}
        <p className="text-lg font-semibold" role="status">
          {score} of {questions.length} correct
        </p>
        <Progress value={(score / questions.length) * 100} aria-label="Score" />
        {more ? <SuggestionChip label={more} /> : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            record(questions.map(() => null));
            setIndex(0);
            setScored(false);
          }}
        >
          <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} data-icon="inline-start" aria-hidden />
          Try again
        </Button>
      </div>
    );

  return (
    <div className="border-border flex flex-col gap-3 rounded-2xl border p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-xs">
          {title ? `${title} · ` : ""}Question {at + 1} of {questions.length}
        </span>
        <div className="flex gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Previous question"
            disabled={at === 0}
            onClick={() => setIndex(at - 1)}
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} aria-hidden />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Next question"
            disabled={last}
            onClick={() => setIndex(at + 1)}
          >
            <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} aria-hidden />
          </Button>
        </div>
      </div>
      <p className="font-medium">
        <Nodes nodes={question.prompt} scope={at} />
      </p>
      <ul className="flex flex-col gap-2" aria-label="Options">
        {question.options.map((option, i) => {
          const right = chosen !== null && option === question.answer;
          const wrong = chosen === option && option !== question.answer;
          return (
            <li key={option}>
              <button
                type="button"
                aria-pressed={chosen === option}
                aria-disabled={chosen !== null}
                onClick={() => pick(option)}
                className={cn(
                  "border-border flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm transition-colors",
                  focusRingClassName,
                  chosen === null && "hover:bg-muted cursor-pointer",
                  right && "border-success bg-success/10",
                  wrong && "border-destructive bg-destructive/10",
                )}
              >
                <span
                  className={cn(
                    "border-border text-muted-foreground grid size-6 shrink-0 place-items-center rounded-full border text-xs",
                    right && "border-success text-success",
                    wrong && "border-destructive text-destructive",
                  )}
                  aria-hidden
                >
                  {right ? (
                    <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-3.5" />
                  ) : wrong ? (
                    <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3.5" />
                  ) : (
                    LETTERS[i]
                  )}
                </span>
                {option}
              </button>
            </li>
          );
        })}
      </ul>
      <div role="status" className="flex flex-col gap-1 text-sm">
        {chosen === null ? (
          hinted === at && question.hint ? (
            <p className="text-muted-foreground">Hint: {question.hint}</p>
          ) : null
        ) : (
          <>
            <p>
              <b className={chosen === question.answer ? "text-success" : "text-destructive"}>
                {chosen === question.answer ? "Correct." : `Not quite: it’s ${question.answer}.`}
              </b>{" "}
              {question.feedback[question.options.indexOf(chosen)] ?? null}
            </p>
            {question.explain ? <p className="text-muted-foreground">{question.explain}</p> : null}
          </>
        )}
      </div>
      <div className="flex justify-end gap-2">
        {question.hint && chosen === null && hinted !== at ? (
          <Button size="sm" variant="ghost" onClick={() => setHinted(at)}>
            Hint
          </Button>
        ) : null}
        <Button
          size="sm"
          disabled={chosen === null}
          onClick={() => (last ? setScored(true) : setIndex(at + 1))}
        >
          {last ? "See score" : "Next"}
        </Button>
      </div>
    </div>
  );
}

/**
 * A formula through KaTeX, as answers render theirs. trust stays off, so TeX
 * cannot add links or raw HTML, and the expansion limits stop a macro bomb.
 */
function MathNode({ node }: { node: ValidNode }) {
  const tex = str(node.props.tex) ?? "";
  const display = node.props.display === true;
  const html = useMemo(
    () =>
      katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        trust: false,
        strict: "ignore",
        maxSize: 20,
        maxExpand: 500,
      }),
    [tex, display],
  );
  const Tag = display ? "div" : "span";
  // oxlint-disable-next-line react/no-danger -- KaTeX output with trust off, the same markup answers render
  return (
    <Tag
      className={display ? "overflow-x-auto" : undefined}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

const clock = (totalSeconds: number) => {
  const whole = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const sec = String(whole % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

interface Clock {
  /** Milliseconds counted before the current run. */
  readonly banked: number;
  readonly startedAt: number | null;
  /** The end was announced, so a remount does not fire ondone again. */
  readonly announced: boolean;
}
const STOPPED: Clock = { banked: 0, startedAt: null, announced: false };

/**
 * Running clocks by block and what they count, outside React: the message
 * list unmounts a row scrolled out of view, and a countdown must still be
 * counting, or have ended, when it comes back.
 */
const clocks = new Map<string, Clock>();

/** A start, pause and reset clock that survives remounts and announces its end once. */
function useClock(spec: string, tickMs: number, total: number | undefined, onEnd: () => void) {
  // Position, not just what it counts: two equal timers in one block are two clocks.
  const key = `${use(BlockKeyContext)}|${use(PathContext)}|${spec}`;
  const [local, setLocal] = useState(() => ({ key, clock: clocks.get(key) ?? STOPPED }));
  // A changed spec is another clock: read its own, not the one shown before.
  const counted = local.key === key ? local.clock : (clocks.get(key) ?? STOPPED);
  const [now, setNow] = useState(() => Date.now());
  const elapsed =
    (counted.banked + (counted.startedAt === null ? 0 : now - counted.startedAt)) / 1000;
  const finished = total !== undefined && elapsed >= total;
  const running = counted.startedAt !== null && !finished;
  const set = (next: Clock) => {
    clocks.set(key, next);
    setLocal({ key, clock: next });
  };

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [running, tickMs]);

  const ended = useRef(onEnd);
  useEffect(() => {
    ended.current = onEnd;
  });
  // Finished stays finished on its own, elapsed only grows; what must outlive a
  // remount is that the end was announced.
  useEffect(() => {
    const stored = clocks.get(key) ?? counted;
    if (!finished || stored.announced) return;
    clocks.set(key, { ...stored, announced: true });
    ended.current();
  }, [finished, key, counted]);

  return {
    elapsed,
    finished,
    running,
    /** The current run's start and what was counted before it, for an animation to begin from. */
    counted,
    start: () => {
      const at = Date.now();
      setNow(at);
      set({ ...counted, startedAt: at });
    },
    pause: () => set({ ...counted, banked: elapsed * 1000, startedAt: null }),
    reset: () => set(STOPPED),
  };
}

/**
 * Counts in the page, never in the block: QuickJS has no timers, and a tick
 * per second through the Worker would cost a handler call for nothing.
 */
function TimerNode({ node }: { node: ValidNode }) {
  const p = node.props;
  const total = num(p.seconds);
  const label = str(p.label);
  const done = useHandler(handlerOf(p.ondone), { event: "change", tag: "timer" });
  const { elapsed, finished, running, counted, start, pause, reset } = useClock(
    `timer:${total ?? ""}:${label ?? ""}`,
    250,
    total,
    () => {
      toast.success(label ? `${label} is done` : "Timer done");
      done?.([]);
    },
  );
  const shown = total === undefined ? elapsed : total - elapsed;
  const reducedMotion = useAppReducedMotion();
  const bar = useRef<HTMLDivElement>(null);
  const sliding = running && !reducedMotion && total !== undefined;
  // While running, the browser moves the bar to the end in one animation:
  // following the 250 ms ticks, it steps however each step is eased.
  useEffect(() => {
    const indicator = bar.current?.querySelector<HTMLElement>('[data-slot="progress-indicator"]');
    if (!sliding || counted.startedAt === null || !indicator?.animate) return;
    const at = counted.banked + Date.now() - counted.startedAt;
    const animation = indicator.animate(
      [{ width: `${Math.min(100, (at / 1000 / total) * 100)}%` }, { width: "100%" }],
      { duration: Math.max(0, total * 1000 - at), easing: "linear", fill: "forwards" },
    );
    return () => animation.cancel();
  }, [sliding, counted.startedAt, counted.banked, total]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col">
          {label ? <span className="text-muted-foreground text-xs">{label}</span> : null}
          <span className="text-3xl font-semibold tabular-nums" role="timer" aria-live="off">
            {finished ? "Done" : clock(shown)}
          </span>
        </div>
        <div className="flex gap-2">
          {running ? (
            <Button size="sm" variant="outline" onClick={pause}>
              <HugeiconsIcon icon={PauseIcon} strokeWidth={2} data-icon="inline-start" />
              Pause
            </Button>
          ) : (
            <Button size="sm" onClick={start} disabled={finished}>
              <HugeiconsIcon icon={PlayIcon} strokeWidth={2} data-icon="inline-start" />
              {elapsed > 0 && !finished ? "Resume" : "Start"}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={reset} disabled={elapsed === 0}>
            <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} data-icon="inline-start" />
            Reset
          </Button>
        </div>
      </div>
      {total !== undefined ? (
        <Progress
          value={Math.min(100, (elapsed / total) * 100)}
          aria-label={label ?? "Timer"}
          ref={bar}
          // A transition would override the animation each time the value moves.
          motion={reducedMotion || sliding ? "none" : "ease"}
        />
      ) : null}
    </div>
  );
}

interface RoutinePhase {
  readonly label: string;
  readonly seconds: number;
  readonly tone: string;
  /** Circle size at the phase's end, carried from the phase before when unset. */
  readonly size: number | undefined;
  readonly children: readonly Child[];
}

function phasesOf(node: ValidNode): RoutinePhase[] {
  const phases = node.children.flatMap((child) => {
    if (typeof child === "string" || child.tag !== "phase") return [];
    const seconds = num(child.props.seconds);
    const label = str(child.props.label);
    if (!seconds || !label) return [];
    return [
      {
        label,
        seconds,
        tone: str(child.props.tone) ?? "primary",
        size: num(child.props.size),
        children: child.children,
      },
    ];
  });
  // A phase without a size holds the one before it; the first wraps to the last.
  let carried = phases.findLast((phase) => phase.size !== undefined)?.size;
  return phases.map((phase) => {
    carried = phase.size ?? carried;
    return { ...phase, size: carried };
  });
}

/** Where a routine is after `elapsed` seconds, or null once every round is done. */
function routineAt(phases: readonly RoutinePhase[], rounds: number, elapsed: number) {
  const cycle = phases.reduce((sum, phase) => sum + phase.seconds, 0);
  if (cycle === 0 || elapsed >= cycle * rounds) return null;
  const round = Math.floor(elapsed / cycle);
  let into = elapsed - round * cycle;
  let index = 0;
  while (into >= phases[index]!.seconds) into -= phases[index++]!.seconds;
  return {
    round,
    index,
    left: phases[index]!.seconds - into,
    progress: into / phases[index]!.seconds,
  };
}

const CIRCLE: Record<string, string> = {
  default: "border-primary bg-primary/15",
  primary: "border-primary bg-primary/15",
  muted: "border-muted-foreground/40 bg-muted",
  success: "border-success bg-success/15",
  warning: "border-warning bg-warning/15",
  destructive: "border-destructive bg-destructive/15",
};
// The smallest circle still holds its label.
const MIN_CIRCLE = 0.3;

/**
 * Phases that follow one another from a single Start, counted in the page like
 * `<timer>`. Moving a circle through script state would need a clock QuickJS
 * does not have, so the page draws the breath too.
 */
function RoutineNode({ node }: { node: ValidNode }) {
  const p = node.props;
  const phases = phasesOf(node);
  const rounds = num(p.rounds) ?? 1;
  const done = useHandler(handlerOf(p.ondone), { event: "change", tag: "routine" });
  const reducedMotion = useAppReducedMotion();
  const total = phases.reduce((sum, phase) => sum + phase.seconds, 0) * rounds;
  const { elapsed, finished, running, start, pause, reset } = useClock(
    `routine:${rounds}:${phases.map((phase) => `${phase.label}/${phase.seconds}`).join(",")}`,
    100,
    phases.length > 0 ? total : undefined,
    () => done?.([]),
  );
  const at = routineAt(phases, rounds, elapsed);

  if (phases.length === 0) return null;

  const index = at?.index ?? phases.length - 1;
  const phase = phases[index]!;
  const next = at ? phases[(index + 1) % phases.length]! : undefined;
  const lastPhase = at && at.round === rounds - 1 && index === phases.length - 1;
  const sized = phases.some((item) => item.size !== undefined);
  const from = phases[(index - 1 + phases.length) % phases.length]!.size ?? 0;
  const to = phase.size ?? from;
  // Eased like a breath: slow at both ends. Without motion, each phase's size at once.
  const eased = at && !reducedMotion ? (1 - Math.cos(Math.PI * at.progress)) / 2 : 1;
  const size = MIN_CIRCLE + (1 - MIN_CIRCLE) * (from + (to - from) * eased);
  const heading = finished ? "Done" : phase.label;
  const count = at ? Math.ceil(at.left) : null;

  return (
    <div className="flex flex-col items-center gap-4">
      {sized ? (
        <div className="relative flex size-44 items-center justify-center">
          <div
            aria-hidden
            className={cn("absolute inset-0 rounded-full border-2", CIRCLE[phase.tone])}
            style={{
              transform: `scale(${size})`,
              // Ticks are 100 ms apart; a matching linear slide joins them up.
              transition: reducedMotion || !running ? undefined : "transform 100ms linear",
            }}
          />
          <div className="relative flex flex-col items-center">
            <span className="text-lg font-semibold" aria-live="polite">
              {heading}
            </span>
            {count !== null && elapsed > 0 ? (
              <span className="text-muted-foreground text-sm tabular-nums">{count}</span>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center">
          <span className={cn("text-2xl font-semibold", TONE[phase.tone])} aria-live="polite">
            {heading}
          </span>
          {count !== null && elapsed > 0 ? (
            <span className="text-3xl font-semibold tabular-nums">{clock(count)}</span>
          ) : null}
        </div>
      )}
      {!finished && phase.children.length > 0 ? (
        <div className="text-muted-foreground text-center text-sm">
          <Nodes nodes={phase.children} scope={index} />
        </div>
      ) : null}
      <div className="text-muted-foreground flex gap-3 text-xs">
        {rounds > 1 && at ? (
          <span>
            Round {at.round + 1} of {rounds}
          </span>
        ) : null}
        {next && !lastPhase ? (
          <span>
            Next: {next.label}, {next.seconds} s
          </span>
        ) : null}
      </div>
      <div className="flex gap-2">
        {running ? (
          <Button size="sm" variant="outline" onClick={pause}>
            <HugeiconsIcon icon={PauseIcon} strokeWidth={2} data-icon="inline-start" />
            Pause
          </Button>
        ) : (
          <Button size="sm" onClick={finished ? reset : start}>
            <HugeiconsIcon
              icon={finished ? RefreshIcon : PlayIcon}
              strokeWidth={2}
              data-icon="inline-start"
            />
            {finished ? "Again" : elapsed > 0 ? "Resume" : "Start"}
          </Button>
        )}
        {!finished ? (
          <Button size="sm" variant="ghost" onClick={reset} disabled={elapsed === 0}>
            <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} data-icon="inline-start" />
            Reset
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Copies its own text, no handler involved: the click is the reader's. */
function CopyNode({ node }: { node: ValidNode }) {
  const p = node.props;
  const text = str(p.text) ?? "";
  const variant = str(p.variant);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button
      size="sm"
      className="w-fit"
      variant={
        variant === "default" || variant === "secondary" || variant === "ghost"
          ? variant
          : "outline"
      }
      disabled={!text}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          toast.success("Copied", { description: copiedPreview(text) });
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <MotionSwap value={copied ? "copied" : "copy"} kind="icon" className="size-4">
        <HugeiconsIcon
          icon={copied ? Tick02Icon : Copy01Icon}
          strokeWidth={2}
          className={copied ? "text-success" : undefined}
          data-icon="inline-start"
          aria-hidden
        />
      </MotionSwap>
      {copied ? "Copied" : <Nodes nodes={node.children} />}
    </Button>
  );
}

function TabsNode({ node }: { node: ValidNode }) {
  const p = node.props;
  const fire = useHandler(handlerOf(p.onchange), { event: "change", tag: "tabs" });
  const tabs = node.children.flatMap((c) => (typeof c === "string" || c.tag !== "tab" ? [] : [c]));
  const valueOf = (tab: ValidNode, index: number) =>
    str(tab.props.value) ?? str(tab.props.label) ?? String(index);
  const controlled = str(p.value);
  const [value, setValue] = useLocal(controlled ?? (tabs[0] ? valueOf(tabs[0], 0) : ""));
  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        if (typeof next !== "string") return;
        setValue(next);
        fire?.([next]);
      }}
    >
      <TabsList>
        {tabs.map((tab, i) => (
          <TabsTrigger key={valueOf(tab, i)} value={valueOf(tab, i)}>
            {str(tab.props.label)}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab, i) => (
        <TabsContent key={valueOf(tab, i)} value={valueOf(tab, i)}>
          <div className="flex flex-col gap-3">
            <Nodes nodes={tab.children} scope={i} />
          </div>
        </TabsContent>
      ))}
    </Tabs>
  );
}

function Node({ node }: { node: ValidNode }) {
  const p = node.props;
  const children = <Nodes nodes={node.children} />;
  switch (node.tag) {
    case "box":
      return (
        <div
          data-ui-anchor={str(p.anchor)}
          className={cn(
            "flex flex-col",
            step(p.gap, GAP, 3),
            step(p.padding, PAD, p.border === true || p.surface === true ? 3 : 0),
            ALIGN[str(p.align) ?? ""],
            p.border === true && "rounded-2xl border",
            p.surface === true && "bg-muted/50 rounded-2xl",
          )}
        >
          {children}
        </div>
      );
    case "row":
      return (
        <div
          data-ui-anchor={str(p.anchor)}
          className={cn(
            "flex flex-row",
            step(p.gap, GAP, 2),
            ALIGN[str(p.align) ?? "center"],
            JUSTIFY[str(p.justify) ?? ""],
            p.wrap === true && "flex-wrap",
          )}
        >
          {children}
        </div>
      );
    case "col":
      return (
        <div
          data-ui-anchor={str(p.anchor)}
          className={cn("flex min-w-0 flex-1 flex-col", step(p.gap, GAP, 2))}
        >
          {children}
        </div>
      );
    case "grid":
      return (
        <div
          data-ui-anchor={str(p.anchor)}
          className={cn("grid grid-cols-1", COLS[num(p.columns) ?? 2], step(p.gap, GAP, 3))}
        >
          {children}
        </div>
      );
    case "cell":
      return (
        <div
          data-ui-anchor={str(p.anchor)}
          className={cn("flex min-w-0 flex-col gap-2", SPAN[num(p.span) ?? 0])}
        >
          {children}
        </div>
      );
    case "card":
      return (
        <Card data-ui-anchor={str(p.anchor)}>
          {str(p.title) ? (
            <CardHeader>
              <CardTitle>{str(p.title)}</CardTitle>
            </CardHeader>
          ) : null}
          <CardContent className="flex flex-col gap-3">{children}</CardContent>
        </Card>
      );
    case "divider":
      return <Separator />;
    case "tabs":
      return <TabsNode node={node} />;
    case "popover":
      return <PopoverNode node={node} />;
    case "disclosure":
      return (
        <Disclosure defaultOpen={p.open === true}>
          <DisclosureTrigger className={cn(disclosureTriggerClassName, focusRingClassName)}>
            {str(p.label)}
          </DisclosureTrigger>
          <DisclosureContent>
            <div className="flex flex-col gap-3 pt-2">{children}</div>
          </DisclosureContent>
        </Disclosure>
      );
    case "title":
      return <h4 className={cn("font-semibold", TITLE_SIZE[str(p.size) ?? "md"])}>{children}</h4>;
    case "text":
      return (
        <p className={cn(TONE[str(p.tone) ?? "default"], TEXT_SIZE[str(p.size) ?? "md"])}>
          {children}
        </p>
      );
    case "b":
      return <strong>{children}</strong>;
    case "i":
      return <em>{children}</em>;
    case "code":
      return (
        <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.9em]">{children}</code>
      );
    case "link":
      return <UiLink href={str(p.href) ?? ""}>{children}</UiLink>;
    case "icon":
      return <IconNode node={node} />;
    case "badge":
      return (
        <Badge
          variant={
            p.tone === "primary"
              ? "default"
              : p.tone === "destructive"
                ? "destructive"
                : "secondary"
          }
        >
          {children}
        </Badge>
      );
    case "stat":
      return (
        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground text-xs">{str(p.label)}</span>
          <span
            className={cn("text-2xl font-semibold tabular-nums", TONE[str(p.tone) ?? "default"])}
          >
            {typeof p.value === "number" ? formatNumber(p.value, undefined) : str(p.value)}
          </span>
          {str(p.delta) ? (
            <span className="text-muted-foreground text-xs">{str(p.delta)}</span>
          ) : null}
        </div>
      );
    case "callout":
      return (
        <div
          className={cn(
            "flex flex-col gap-1 rounded-2xl border p-3 text-sm",
            CALLOUT[str(p.tone) ?? "info"],
          )}
        >
          {str(p.title) ? <strong>{str(p.title)}</strong> : null}
          {children}
        </div>
      );
    case "list":
      return p.ordered === true ? (
        <ol className="list-decimal space-y-1 pl-5 text-sm">{children}</ol>
      ) : (
        <ul className="list-disc space-y-1 pl-5 text-sm">{children}</ul>
      );
    case "item":
      return <li>{children}</li>;
    case "num":
      return <span className="tabular-nums">{formatNumber(num(p.value) ?? 0, str(p.format))}</span>;
    case "date":
      return <span>{formatDate(p.value, str(p.format))}</span>;
    case "button":
      return <ButtonNode node={node} />;
    case "segmented":
      return <SegmentedNode node={node} />;
    case "slider":
      return <SliderNode node={node} />;
    case "input":
      return <TextInputNode node={node} numeric={false} />;
    case "number":
      return <TextInputNode node={node} numeric />;
    case "select":
      return <SelectNode node={node} />;
    case "checkbox":
    case "switch":
      return <ToggleNode node={node} />;
    case "stepper":
      return <StepperNode node={node} />;
    case "datepicker":
      return <DatePickerNode node={node} />;
    case "celebrate":
      return <Celebrate when={p.when === true} />;
    case "table":
      return <UiTable node={node} />;
    case "progress":
      return <UiProgress node={node} />;
    case "chart":
      return <UiChart node={node} />;
    case "svg":
      return <UiSvg node={node} />;
    case "image":
      return <UiImage node={node} />;
    case "images":
      return <UiImages node={node} />;
    case "math":
      return <MathNode node={node} />;
    case "choice":
      return <ChoiceNode node={node} />;
    case "steps":
      return <StepsNode node={node} />;
    case "wizard":
      return <WizardNode node={node} />;
    case "quiz":
      return <QuizNode node={node} />;
    case "map":
      return <UiMap node={node} renderContent={(nodes) => <Nodes nodes={nodes} />} />;
    case "timer":
      return <TimerNode node={node} />;
    case "routine":
      return <RoutineNode node={node} />;
    case "copy":
      return <CopyNode node={node} />;
    case "suggestions":
      return <div className="flex flex-wrap gap-2">{children}</div>;
    case "suggestion":
      return <SuggestionNode node={node} />;
    default:
      return null;
  }
}

/**
 * A node's children. A container drawing one of its child's contents directly
 * (a tab's, a step's) passes that child's index as `scope`, so identical
 * contents of two tabs keep apart.
 */
export function Nodes({ nodes, scope }: { nodes: readonly Child[]; scope?: number }) {
  const parent = use(PathContext);
  const base = scope === undefined ? parent : `${parent}:${scope}`;
  return nodes.map((child, i) =>
    typeof child === "string" ? (
      child
    ) : (
      // oxlint-disable-next-line react/no-array-index-key, react/jsx-no-constructed-context-values -- tree order is the identity, and a string value compares by value
      <PathContext key={`${child.tag}-${i}`} value={`${base}/${i}`}>
        <Node node={child} />
      </PathContext>
    ),
  );
}
