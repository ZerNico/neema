import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Delete02Icon,
  PaintBoardIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type {
  ConditionalFormat,
  ConditionalRule,
  ConditionalStyle,
} from "@chat/sheet/model/conditional";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Field, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { ToolbarMenu } from "../../ui/ribbon-controls.tsx";

/** Excel's ready-made highlight styles. */
const STYLES: ReadonlyArray<{ value: string; label: string; style: ConditionalStyle }> = [
  {
    value: "red",
    label: "Light red fill with dark red text",
    style: { fill: "#FFC7CE", fontColor: "#9C0006" },
  },
  {
    value: "yellow",
    label: "Yellow fill with dark yellow text",
    style: { fill: "#FFEB9C", fontColor: "#9C5700" },
  },
  {
    value: "green",
    label: "Green fill with dark green text",
    style: { fill: "#C6EFCE", fontColor: "#006100" },
  },
  { value: "fill", label: "Light red fill", style: { fill: "#FFC7CE" } },
  { value: "text", label: "Red text", style: { fontColor: "#9C0006" } },
  { value: "bold", label: "Bold", style: { bold: true } },
];
const BARS = [
  { label: "Blue", color: "#638EC6" },
  { label: "Green", color: "#63BE7B" },
  { label: "Red", color: "#F8696B" },
  { label: "Orange", color: "#FFB628" },
  { label: "Light blue", color: "#008AEF" },
  { label: "Purple", color: "#D6007B" },
] as const;
const SCALES: ReadonlyArray<{
  label: string;
  colors: readonly [string, string] | readonly [string, string, string];
}> = [
  { label: "Green, yellow, red", colors: ["#F8696B", "#FFEB84", "#63BE7B"] },
  { label: "Red, yellow, green", colors: ["#63BE7B", "#FFEB84", "#F8696B"] },
  { label: "Blue, white, red", colors: ["#5A8AC6", "#FCFCFF", "#F8696B"] },
  { label: "White to green", colors: ["#FCFCFF", "#63BE7B"] },
  { label: "White to red", colors: ["#FCFCFF", "#F8696B"] },
  { label: "Yellow to green", colors: ["#FFEF9C", "#63BE7B"] },
];

/** A rule asked about in a dialog: what it tests and how many values that takes. */
type Asking =
  | { kind: "compare"; op: "greater" | "less" | "between" | "equal"; title: string }
  | { kind: "text"; title: string }
  | { kind: "top"; percent: boolean; bottom: boolean; title: string }
  | { kind: "average"; below: boolean; title: string }
  | { kind: "duplicate"; title: string }
  | { kind: "blank"; title: string };

/** In words, as Manage Rules lists a rule. */
function describeRule(rule: ConditionalRule) {
  switch (rule.kind) {
    case "compare":
      return `Value ${rule.op.replace(/([A-Z])/g, " $1").toLowerCase()} ${rule.values.join(" and ")}`;
    case "text":
      return `Text ${rule.op.replace(/([A-Z])/g, " $1").toLowerCase()} “${rule.text}”`;
    case "top":
      return `${rule.bottom ? "Bottom" : "Top"} ${rule.count}${rule.percent ? "%" : ""}`;
    case "average":
      return rule.below ? "Below average" : "Above average";
    case "duplicate":
      return rule.unique ? "Unique values" : "Duplicate values";
    case "blank":
      return rule.not ? "Cells with something" : "Blank cells";
    case "scale":
      return `Colour scale of ${rule.colors.length}`;
    case "bar":
      return "Data bar";
  }
}

/** A typed operand: a number when it reads as one, else its text. */
const operand = (text: string) => {
  const number = Number(text.replace(",", "."));
  return text.trim() !== "" && Number.isFinite(number) ? number : text;
};

function RuleDialog({
  asking,
  onAdd,
  onClose,
}: {
  asking: Asking;
  onAdd: (rule: ConditionalRule) => void;
  onClose: () => void;
}) {
  const [first, setFirst] = useState(asking.kind === "top" ? "10" : "");
  const [second, setSecond] = useState("");
  const [styleKey, setStyleKey] = useState("red");
  const style = STYLES.find((each) => each.value === styleKey)!.style;
  const rule = ((): ConditionalRule | null => {
    switch (asking.kind) {
      case "compare":
        if (!first.trim() || (asking.op === "between" && !second.trim())) return null;
        return {
          kind: "compare",
          op: asking.op,
          values: asking.op === "between" ? [operand(first), operand(second)] : [operand(first)],
          style,
        };
      case "text":
        return first ? { kind: "text", op: "contains", text: first, style } : null;
      case "top": {
        const count = Math.round(Number(first));
        return count >= 1 && count <= 1000
          ? { kind: "top", count, percent: asking.percent, bottom: asking.bottom, style }
          : null;
      }
      case "average":
        return { kind: "average", below: asking.below, style };
      case "duplicate":
        return { kind: "duplicate", style };
      case "blank":
        return { kind: "blank", style };
    }
  })();
  const asksValue = asking.kind === "compare" || asking.kind === "text" || asking.kind === "top";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{asking.title}</DialogTitle>
          <DialogDescription>Format the selected cells that match.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {asksValue ? (
            <div className="flex items-end gap-2">
              <Field>
                <FieldLabel htmlFor="rule-first">
                  {asking.kind === "top" ? (asking.percent ? "Percent" : "Items") : "Value"}
                </FieldLabel>
                <Input
                  id="rule-first"
                  autoFocus
                  value={first}
                  onChange={(event) => setFirst(event.target.value)}
                />
              </Field>
              {asking.kind === "compare" && asking.op === "between" ? (
                <Field>
                  <FieldLabel htmlFor="rule-second">And</FieldLabel>
                  <Input
                    id="rule-second"
                    value={second}
                    onChange={(event) => setSecond(event.target.value)}
                  />
                </Field>
              ) : null}
            </div>
          ) : null}
          <Field>
            <FieldLabel htmlFor="rule-style">With</FieldLabel>
            <Select
              items={STYLES}
              value={styleKey}
              onValueChange={(next) => {
                if (next) setStyleKey(next);
              }}
            >
              <SelectTrigger id="rule-style" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STYLES.map((each) => (
                  <SelectItem key={each.value} value={each.value}>
                    <span
                      className="rounded-sm px-1"
                      // The style's own colours, which the sheet keeps as data.
                      style={{
                        backgroundColor: each.style.fill,
                        color: each.style.fontColor,
                        fontWeight: each.style.bold ? 600 : undefined,
                      }}
                    >
                      {each.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!rule}
            onClick={() => {
              if (!rule) return;
              onAdd(rule);
              onClose();
            }}
          >
            OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ManageDialog({
  rules,
  where,
  onEdit,
  onClose,
}: {
  rules: readonly ConditionalFormat[];
  where: (rule: ConditionalFormat) => string;
  onEdit: (id: string, action: "remove" | "up" | "down") => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Conditional formatting rules</DialogTitle>
          <DialogDescription>Rules higher in the list win where they overlap.</DialogDescription>
        </DialogHeader>
        {rules.length ? (
          <ol className="flex flex-col gap-1">
            {rules.map((rule, index) => (
              <li key={rule.id} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{describeRule(rule.rule)}</span>
                <span className="text-muted-foreground shrink-0 text-xs">{where(rule)}</span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Move up"
                  disabled={index === 0}
                  onClick={() => onEdit(rule.id, "up")}
                >
                  <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={2} />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Move down"
                  disabled={index === rules.length - 1}
                  onClick={() => onEdit(rule.id, "down")}
                >
                  <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Delete rule"
                  onClick={() => onEdit(rule.id, "remove")}
                >
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                </Button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground text-sm">This sheet has no rules.</p>
        )}
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Excel's Conditional Formatting menu: highlight and top or bottom rules,
 * asked about in a dialog; data bars and colour scales in one click; clearing;
 * and the list of the sheet's rules.
 */
export function ConditionalMenu({
  rules,
  where,
  onAdd,
  onClear,
  onEdit,
}: {
  rules: readonly ConditionalFormat[];
  /** A rule's range as A1 text. */
  where: (rule: ConditionalFormat) => string;
  onAdd: (rule: ConditionalRule) => void;
  onClear: (scope: "selection" | "sheet") => void;
  onEdit: (id: string, action: "remove" | "up" | "down") => void;
}) {
  const [asking, setAsking] = useState<Asking | null>(null);
  const [managing, setManaging] = useState(false);
  const ask = (next: Asking) => () => setAsking(next);
  return (
    <>
      <ToolbarMenu label="Conditional formatting" icon={PaintBoardIcon}>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Highlight cells rules</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48">
              <DropdownMenuItem
                onClick={ask({ kind: "compare", op: "greater", title: "Greater than" })}
              >
                Greater than…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={ask({ kind: "compare", op: "less", title: "Less than" })}>
                Less than…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={ask({ kind: "compare", op: "between", title: "Between" })}>
                Between…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={ask({ kind: "compare", op: "equal", title: "Equal to" })}>
                Equal to…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={ask({ kind: "text", title: "Text that contains" })}>
                Text that contains…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={ask({ kind: "duplicate", title: "Duplicate values" })}>
                Duplicate values…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={ask({ kind: "blank", title: "Blank cells" })}>
                Blank cells…
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Top and bottom rules</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48">
              <DropdownMenuItem
                onClick={ask({ kind: "top", percent: false, bottom: false, title: "Top items" })}
              >
                Top 10 items…
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={ask({ kind: "top", percent: true, bottom: false, title: "Top percent" })}
              >
                Top 10%…
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={ask({ kind: "top", percent: false, bottom: true, title: "Bottom items" })}
              >
                Bottom 10 items…
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={ask({ kind: "top", percent: true, bottom: true, title: "Bottom percent" })}
              >
                Bottom 10%…
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={ask({ kind: "average", below: false, title: "Above average" })}
              >
                Above average…
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={ask({ kind: "average", below: true, title: "Below average" })}
              >
                Below average…
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Data bars</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-40">
              {BARS.map((bar) => (
                <DropdownMenuItem
                  key={bar.color}
                  onClick={() => onAdd({ kind: "bar", color: bar.color })}
                >
                  <span className="h-3 w-6 rounded-xs" style={{ backgroundColor: bar.color }} />
                  {bar.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Colour scales</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-52">
              {SCALES.map((scale) => (
                <DropdownMenuItem
                  key={scale.label}
                  onClick={() => onAdd({ kind: "scale", colors: scale.colors })}
                >
                  <span
                    className="h-3 w-8 rounded-xs"
                    style={{
                      background: `linear-gradient(to right, ${scale.colors.toReversed().join(", ")})`,
                    }}
                  />
                  {scale.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onClear("selection")}>
            Clear rules from selected cells
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onClear("sheet")}>
            Clear rules from entire sheet
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setManaging(true)}>Manage rules…</DropdownMenuItem>
        </DropdownMenuContent>
      </ToolbarMenu>
      {asking ? <RuleDialog asking={asking} onAdd={onAdd} onClose={() => setAsking(null)} /> : null}
      {managing ? (
        <ManageDialog
          rules={rules}
          where={where}
          onEdit={onEdit}
          onClose={() => setManaging(false)}
        />
      ) : null}
    </>
  );
}
