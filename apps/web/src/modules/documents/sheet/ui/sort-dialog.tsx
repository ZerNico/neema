import { Add01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { SortKey } from "@chat/sheet-react/commands";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Field, FieldLabel } from "~/ui/primitives/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { Switch } from "~/ui/primitives/switch";

// Levels are named by a number of their own, so removing one keeps the others' fields.
let levels = 0;
const level = (column: string): SortKey & { level: number } => ({
  column,
  descending: false,
  level: ++levels,
});

const ORDERS = [
  { value: "ascending", label: "A to Z, smallest first" },
  { value: "descending", label: "Z to A, largest first" },
] as const;

/**
 * Excel's Sort dialog: sort the selection by one column, then by more in
 * turn, its first row kept as headers when it holds them.
 */
export function SortDialog({
  columns,
  headersByDefault,
  onSort,
  onClose,
}: {
  /** The selection's columns by ID, named by header text when the first row has one. */
  columns: ReadonlyArray<{ id: string; letter: string; header: string }>;
  headersByDefault: boolean;
  onSort: (keys: SortKey[], headers: boolean) => void;
  onClose: () => void;
}) {
  const [headers, setHeaders] = useState(headersByDefault);
  const [keys, setKeys] = useState(() => [level(columns[0]!.id)]);
  const options = columns.map((column) => ({
    value: column.id,
    label: headers && column.header ? column.header : `Column ${column.letter}`,
  }));
  const change = (index: number, next: Partial<SortKey>) =>
    setKeys(keys.map((key, at) => (at === index ? { ...key, ...next } : key)));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Sort range</DialogTitle>
          <DialogDescription>
            Each level sorts the rows the levels above leave tied.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field orientation="horizontal">
            <FieldLabel htmlFor="sort-headers">My data has headers</FieldLabel>
            <Switch id="sort-headers" checked={headers} onCheckedChange={setHeaders} />
          </Field>
          <ol className="flex flex-col gap-2">
            {keys.map((key, index) => (
              <li key={key.level} className="flex items-center gap-2">
                <span className="text-muted-foreground w-16 shrink-0 text-xs">
                  {index ? "Then by" : "Sort by"}
                </span>
                <Select
                  items={options}
                  value={key.column}
                  onValueChange={(column) => {
                    if (column) change(index, { column });
                  }}
                >
                  <SelectTrigger
                    aria-label={`Level ${index + 1} column`}
                    className="min-w-0 flex-1"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  items={ORDERS}
                  value={key.descending ? "descending" : "ascending"}
                  onValueChange={(order) => change(index, { descending: order === "descending" })}
                >
                  <SelectTrigger aria-label={`Level ${index + 1} order`} className="w-52">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ORDERS.map((order) => (
                      <SelectItem key={order.value} value={order.value}>
                        {order.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove level ${index + 1}`}
                  disabled={keys.length === 1}
                  onClick={() => setKeys(keys.filter((_, at) => at !== index))}
                >
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                </Button>
              </li>
            ))}
          </ol>
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            disabled={keys.length >= Math.min(columns.length, 8)}
            onClick={() => setKeys([...keys, level(columns[0]!.id)])}
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            Add level
          </Button>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onSort(
                keys.map(({ column, descending }) => ({ column, descending })),
                headers,
              );
              onClose();
            }}
          >
            Sort
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
