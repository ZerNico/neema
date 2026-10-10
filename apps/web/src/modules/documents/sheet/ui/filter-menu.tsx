import { SortingAZ01Icon, SortingZA01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { FilterCondition, FilterRule } from "@chat/sheet/model/filter";
import { Button } from "~/ui/primitives/button";
import { Checkbox } from "~/ui/primitives/checkbox";
import { Input } from "~/ui/primitives/input";
import { Popover, PopoverContent } from "~/ui/primitives/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { Separator } from "~/ui/primitives/separator";

const CONDITIONS: ReadonlyArray<{ value: FilterCondition | "none"; label: string }> = [
  { value: "none", label: "None" },
  { value: "equals", label: "Equals" },
  { value: "notEquals", label: "Does not equal" },
  { value: "contains", label: "Contains" },
  { value: "notContains", label: "Does not contain" },
  { value: "beginsWith", label: "Begins with" },
  { value: "endsWith", label: "Ends with" },
  { value: "greater", label: "Greater than" },
  { value: "greaterOrEqual", label: "Greater than or equal to" },
  { value: "less", label: "Less than" },
  { value: "lessOrEqual", label: "Less than or equal to" },
  { value: "empty", label: "Is empty" },
  { value: "notEmpty", label: "Is not empty" },
];
/** A long list shows this many values; the search finds the rest. */
const SHOWN = 500;

/**
 * A filter button's menu, as Excel's: sort the filter by this column, test
 * it by a condition, or keep only the values ticked. Nothing changes until
 * OK, so ticking through a long list is one change.
 */
export function FilterMenu({
  anchor,
  name,
  choices,
  rule,
  onApply,
  onSort,
  onClose,
}: {
  anchor: HTMLElement;
  /** The column's header text, or its letter. */
  name: string;
  choices: ReadonlyArray<{ value: string; count: number }>;
  rule: FilterRule | undefined;
  onApply: (rule: FilterRule | null) => void;
  onSort: (descending: boolean) => void;
  onClose: () => void;
}) {
  const [kept, setKept] = useState<ReadonlySet<string>>(
    () => new Set(rule?.values ?? choices.map((each) => each.value)),
  );
  const [condition, setCondition] = useState<FilterCondition | "none">(
    rule?.condition?.op ?? "none",
  );
  const [operand, setOperand] = useState(String(rule?.condition?.value ?? ""));
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const listed = choices.filter((each) => !query || each.value.toLowerCase().includes(query));
  const everything = choices.every((each) => kept.has(each.value));
  const toggle = (value: string, on: boolean) => {
    const next = new Set(kept);
    if (on) next.add(value);
    else next.delete(value);
    setKept(next);
  };
  const apply = () => {
    const needsOperand = condition !== "none" && condition !== "empty" && condition !== "notEmpty";
    const number = Number(operand.replace(",", "."));
    const next: FilterRule = {
      ...(everything ? {} : { values: [...kept] }),
      ...(condition === "none"
        ? {}
        : {
            condition: {
              op: condition,
              ...(needsOperand
                ? { value: operand.trim() !== "" && Number.isFinite(number) ? number : operand }
                : {}),
            },
          }),
    };
    onApply(next.values || next.condition ? next : null);
    onClose();
  };
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverContent anchor={anchor} align="start" className="w-72">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col">
            <Button
              size="sm"
              variant="ghost"
              className="justify-start"
              onClick={() => {
                onSort(false);
                onClose();
              }}
            >
              <HugeiconsIcon icon={SortingAZ01Icon} strokeWidth={2} />
              Sort A to Z
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="justify-start"
              onClick={() => {
                onSort(true);
                onClose();
              }}
            >
              <HugeiconsIcon icon={SortingZA01Icon} strokeWidth={2} />
              Sort Z to A
            </Button>
          </div>
          <Separator />
          <div className="flex flex-col gap-2">
            <span className="text-muted-foreground text-xs">Filter {name} by condition</span>
            <Select
              items={CONDITIONS}
              value={condition}
              onValueChange={(next) => {
                if (next) setCondition(next);
              }}
            >
              <SelectTrigger aria-label="Condition" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONDITIONS.map((each) => (
                  <SelectItem key={each.value} value={each.value}>
                    {each.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {condition !== "none" && condition !== "empty" && condition !== "notEmpty" ? (
              <Input
                aria-label="Value"
                placeholder="Value"
                value={operand}
                onChange={(event) => setOperand(event.target.value)}
              />
            ) : null}
          </div>
          <Separator />
          <div className="flex flex-col gap-2">
            <span className="text-muted-foreground text-xs">Filter by values</span>
            <Input
              aria-label="Search values"
              placeholder="Search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="flex gap-2">
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setKept(new Set(choices.map((each) => each.value)))}
              >
                Select all
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setKept(new Set())}>
                Clear
              </Button>
            </div>
            <ul aria-label="Values" className="flex max-h-56 flex-col gap-1 overflow-y-auto">
              {listed.slice(0, SHOWN).map((each) => (
                <li key={each.value}>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={kept.has(each.value)}
                      onCheckedChange={(on) => toggle(each.value, on)}
                    />
                    <span className="min-w-0 flex-1 truncate">{each.value || "(Blanks)"}</span>
                    <span className="text-muted-foreground text-xs tabular-nums">{each.count}</span>
                  </label>
                </li>
              ))}
              {listed.length > SHOWN ? (
                <li className="text-muted-foreground text-xs">
                  {listed.length - SHOWN} more; search to find them
                </li>
              ) : null}
            </ul>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={apply}>
              OK
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
