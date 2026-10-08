// Draws a validated tree with the app's own components. Props arrive already
// checked against the catalog, so each component only maps them onto ours;
// anything it does not recognise renders nothing rather than guessing.

import katex from "katex";
import { use, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
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
import { SegmentedControl, SegmentedControlItem } from "~/ui/segmented-control.tsx";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "~/ui/disclosure.tsx";
import { disclosureTriggerClassName } from "~/ui/disclosure-classes.ts";
import { focusRingClassName } from "~/ui/focus-ring.ts";
import { cn } from "~/ui/utils";
import type { ValidNode } from "../catalog.ts";
import { UiChart, UiProgress, UiSvg, UiTable } from "./data.tsx";
import { handlerOf, useHandler } from "./handler.ts";
import { UiLink } from "./link.tsx";
import { UiMap } from "./map.tsx";
import { UiImage, UiImages } from "./media.tsx";
import { copiedPreview } from "../text.ts";
import { SuggestContext } from "./context.ts";

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

function formatNumber(value: number, format: string | undefined): string {
  const locale = typeof navigator === "undefined" ? undefined : navigator.language;
  const [kind = "decimal", arg] = (format ?? "decimal").split(":");
  try {
    if (kind === "percent") {
      const digits = arg ? Number(arg) : 0;
      return new Intl.NumberFormat(locale, {
        style: "percent",
        maximumFractionDigits: digits,
      }).format(value);
    }
    if (kind === "compact")
      return new Intl.NumberFormat(locale, { notation: "compact" }).format(value);
    if (kind === "currency" && arg)
      return new Intl.NumberFormat(locale, { style: "currency", currency: arg }).format(value);
    const digits = arg ? Number(arg) : undefined;
    return new Intl.NumberFormat(
      locale,
      digits === undefined ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits },
    ).format(value);
  } catch {
    return String(value);
  }
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
        aria-label={str(p.label) ?? str(p.placeholder) ?? "Input"}
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
            <RadioGroupItem value={o.value} />
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
  const suggest = use(SuggestContext);
  const label = textOf(node.children);
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
                  <Nodes nodes={step.children} />
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
        <Nodes nodes={step.children} />
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

/**
 * Counts in the page, never in the block: QuickJS has no timers, and a tick
 * per second through the Worker would cost a handler call for nothing.
 */
function TimerNode({ node }: { node: ValidNode }) {
  const p = node.props;
  const total = num(p.seconds);
  const label = str(p.label);
  const done = useHandler(handlerOf(p.ondone), { event: "change", tag: "timer" });
  // Time already counted, plus the moment the current run started.
  const [banked, setBanked] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const elapsed = (banked + (startedAt === null ? 0 : now - startedAt)) / 1000;
  const finished = total !== undefined && elapsed >= total;
  const running = startedAt !== null && !finished;

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [running]);

  const announced = useRef(false);
  useEffect(() => {
    if (!finished || announced.current) return;
    announced.current = true;
    setStartedAt(null);
    setBanked((total ?? 0) * 1000);
    toast.success(label ? `${label} is done` : "Timer done");
    done?.([]);
  }, [finished, total, label, done]);

  const start = () => {
    const at = Date.now();
    setNow(at);
    setStartedAt(at);
  };
  const pause = () => {
    setBanked(elapsed * 1000);
    setStartedAt(null);
  };
  const reset = () => {
    announced.current = false;
    setBanked(0);
    setStartedAt(null);
  };
  const shown = total === undefined ? elapsed : total - elapsed;

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
        <Progress value={Math.min(100, (elapsed / total) * 100)} aria-label={label ?? "Timer"} />
      ) : null}
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
            <Nodes nodes={tab.children} />
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
        <div className={cn("flex min-w-0 flex-1 flex-col", step(p.gap, GAP, 2))}>{children}</div>
      );
    case "grid":
      return (
        <div className={cn("grid grid-cols-1", COLS[num(p.columns) ?? 2], step(p.gap, GAP, 3))}>
          {children}
        </div>
      );
    case "cell":
      return (
        <div className={cn("flex min-w-0 flex-col gap-2", SPAN[num(p.span) ?? 0])}>{children}</div>
      );
    case "card":
      return (
        <Card>
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
    case "map":
      return <UiMap node={node} renderContent={(nodes) => <Nodes nodes={nodes} />} />;
    case "timer":
      return <TimerNode node={node} />;
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

export function Nodes({ nodes }: { nodes: readonly Child[] }) {
  return nodes.map((child, i) =>
    // oxlint-disable-next-line react/no-array-index-key -- tree order is the identity; siblings may be identical
    typeof child === "string" ? child : <Node key={`${child.tag}-${i}`} node={child} />,
  );
}
