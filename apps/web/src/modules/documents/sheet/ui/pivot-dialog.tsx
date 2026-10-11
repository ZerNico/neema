import { useState } from "react";
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

const SUMMARIES = [
  { value: "SUM", label: "Sum" },
  { value: "AVERAGE", label: "Average" },
  { value: "COUNT", label: "Count of numbers" },
  { value: "COUNTA", label: "Count of values" },
  { value: "MIN", label: "Minimum" },
  { value: "MAX", label: "Maximum" },
  { value: "PERCENTOF", label: "Share of total" },
] as const;
const PLACES = [
  { value: "sheet", label: "A new sheet" },
  { value: "beside", label: "Beside the data" },
] as const;

/** One labelled choice of the dialog's. */
function Pick<T extends string>({
  id,
  label,
  items,
  value,
  onChange,
}: {
  id: string;
  label: string;
  items: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select items={items} value={value} onValueChange={(next) => next && onChange(next)}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((each) => (
            <SelectItem key={each.value} value={each.value}>
              {each.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** What the dialog asks for: fields by their column in the data, from 0. */
export interface PivotDraft {
  readonly rows: number;
  readonly columns: number | null;
  readonly values: number;
  readonly summary: (typeof SUMMARIES)[number]["value"];
  readonly place: (typeof PLACES)[number]["value"];
  readonly headers: boolean;
}

/**
 * Excel's Insert PivotTable, as a GROUPBY or PIVOTBY formula: rows grouped by
 * one column, optionally crossed with another, a third summarised. Being a
 * formula, it recalculates with its data.
 */
export function PivotDialog({
  fields,
  onApply,
  onClose,
}: {
  /** Each column of the data, named by its first row. */
  fields: readonly string[];
  onApply: (draft: PivotDraft) => void;
  onClose: () => void;
}) {
  const options = fields.map((label, index) => ({ value: String(index), label }));
  const [rows, setRows] = useState("0");
  const [columns, setColumns] = useState("none");
  const [values, setValues] = useState(String(Math.max(0, fields.length - 1)));
  const [summary, setSummary] = useState<PivotDraft["summary"]>("SUM");
  const [place, setPlace] = useState<PivotDraft["place"]>("sheet");
  const [headers, setHeaders] = useState(true);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Insert pivot table</DialogTitle>
          <DialogDescription>Summarise the selected data by its columns.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Pick id="pivot-rows" label="Rows" items={options} value={rows} onChange={setRows} />
          <Pick
            id="pivot-columns"
            label="Columns"
            items={[{ value: "none", label: "None" }, ...options]}
            value={columns}
            onChange={setColumns}
          />
          <Pick
            id="pivot-values"
            label="Values"
            items={options}
            value={values}
            onChange={setValues}
          />
          <Pick
            id="pivot-summary"
            label="Summarise by"
            items={SUMMARIES}
            value={summary}
            onChange={setSummary}
          />
          <Pick
            id="pivot-place"
            label="Put it on"
            items={PLACES}
            value={place}
            onChange={setPlace}
          />
          <Field orientation="horizontal">
            <FieldLabel htmlFor="pivot-headers">First row holds the column names</FieldLabel>
            <Switch id="pivot-headers" checked={headers} onCheckedChange={setHeaders} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onApply({
                rows: Number(rows),
                columns: columns === "none" ? null : Number(columns),
                values: Number(values),
                summary,
                place,
                headers,
              });
              onClose();
            }}
          >
            Insert
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
