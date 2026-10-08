// Draws a validated tree with the app's own components. Props arrive already
// checked against the catalog, so each component only maps them onto ours;
// anything it does not recognise renders nothing rather than guessing.

import { use, useEffect, useRef, useState, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "~/ui/card.tsx";
import { LeaveDialog } from "~/ui/leave-dialog.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Checkbox } from "~/ui/primitives/checkbox";
import { Input } from "~/ui/primitives/input";
import { Label } from "~/ui/primitives/label";
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
import { DispatchContext, type HandlerRef, type TrustedEvent } from "./context.ts";

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

function handlerOf(value: unknown): HandlerRef | undefined {
  if (typeof value !== "object" || value === null || !("$h" in value) || !("rev" in value))
    return undefined;
  const { $h, rev } = value;
  return typeof $h === "number" && typeof rev === "number" ? { $h, rev } : undefined;
}

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

/**
 * Calls a handler with the latest arguments, one call at a time. A slider
 * fires on every pixel; between replies only the newest value matters, and
 * it is sent through the handler of the tree that reply produced.
 */
function useHandler(ref: HandlerRef | undefined, trusted: TrustedEvent) {
  const dispatch = use(DispatchContext);
  const inFlight = useRef(false);
  const queued = useRef<readonly unknown[] | null>(null);
  const send = (target: HandlerRef, args: readonly unknown[]) => {
    inFlight.current = true;
    void dispatch(target, args, trusted).finally(() => {
      inFlight.current = false;
    });
  };
  // A queued value goes out once the new tree, with its fresh handler, lands.
  useEffect(() => {
    if (!ref || inFlight.current || !queued.current) return;
    const args = queued.current;
    queued.current = null;
    send(ref, args);
  });
  if (!ref) return undefined;
  return (args: readonly unknown[]) => {
    if (inFlight.current) queued.current = args;
    else send(ref, args);
  };
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

function UiLink({ href, children }: { href: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <a
        href={href}
        className="text-primary underline underline-offset-4"
        onClick={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
      >
        {children}
      </a>
      <LeaveDialog
        isOpen={open}
        url={href}
        onClose={() => setOpen(false)}
        onConfirm={() => {
          window.open(href, "_blank", "noopener,noreferrer");
          setOpen(false);
        }}
      />
    </>
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
          value={value}
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

function ButtonNode({ node }: { node: ValidNode }) {
  const p = node.props;
  const fire = useHandler(handlerOf(p.onclick), { event: "click", tag: "button" });
  const variant = str(p.variant);
  return (
    <Button
      size="sm"
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
    case "suggestions":
      return <div className="flex flex-wrap gap-2">{children}</div>;
    case "suggestion":
      return (
        <Button size="sm" variant="outline" disabled>
          {children}
        </Button>
      );
    default:
      return null;
  }
}

export function Nodes({ nodes }: { nodes: readonly Child[] }) {
  return nodes.map((child, i) =>
    typeof child === "string" ? child : <Node key={`${child.tag}-${i}`} node={child} />,
  );
}
