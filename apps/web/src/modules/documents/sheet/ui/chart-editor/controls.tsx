import { ColorPicker } from "~/ui/color-picker";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useState, type ReactNode } from "react";
import { Button } from "~/ui/primitives/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/ui/primitives/collapsible";
import { Field, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Popover, PopoverContent, PopoverTrigger } from "~/ui/primitives/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { Switch } from "~/ui/primitives/switch";
import { cn } from "~/ui/utils";

/**
 * Text that takes effect when let go, on Enter or leaving the field, so one
 * edit is one change to undo rather than one per keystroke. Escape puts it
 * back.
 */
export function CommitInput({
  label,
  value,
  onCommit,
  placeholder,
  invalid = false,
  disabled = false,
}: {
  label: string;
  value: string;
  onCommit: (text: string) => void;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={draft ?? value}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          else if (event.key === "Escape") setDraft(null);
        }}
      />
    </Field>
  );
}

/** A number, or empty for automatic. */
export function NumberInput({
  label,
  value,
  onCommit,
  disabled = false,
}: {
  label: string;
  value: number | undefined;
  onCommit: (value: number | null) => void;
  disabled?: boolean;
}) {
  return (
    <CommitInput
      label={label}
      value={value === undefined ? "" : String(value)}
      placeholder="Auto"
      disabled={disabled}
      onCommit={(text) => {
        const number = Number(text.replace(",", "."));
        if (!text.trim()) onCommit(null);
        else if (Number.isFinite(number)) onCommit(number);
      }}
    />
  );
}

export function SwitchField({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Field orientation="horizontal">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </Field>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        items={options}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <SelectTrigger id={id} className="w-full">
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
    </Field>
  );
}

/** Number formats a chart offers, as Excel codes; Automatic follows the cells. */
const FORMATS = [
  { value: "", label: "Automatic" },
  { value: "General", label: "General" },
  { value: "#,##0", label: "1,234" },
  { value: "#,##0.00", label: "1,234.56" },
  { value: "$#,##0", label: "$1,234" },
  { value: "$#,##0.00", label: "$1,234.56" },
  { value: "0%", label: "12%" },
  { value: "0.0%", label: "12.3%" },
  { value: "0.00E+00", label: "1.23E+03" },
  { value: "yyyy-mm-dd", label: "2026-10-10" },
  { value: "mmm yyyy", label: "Oct 2026" },
] as const;
const CUSTOM = "custom";

/** A number format by example, or a custom Excel code. */
export function FormatField({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string | undefined;
  onChange: (code: string | null) => void;
  disabled?: boolean;
}) {
  const known = FORMATS.some((format) => format.value === (value ?? ""));
  const [custom, setCustom] = useState(!known);
  const options = [...FORMATS, { value: CUSTOM, label: "Custom…" }];
  return (
    <>
      <SelectField
        label={label}
        value={custom ? CUSTOM : (value ?? "")}
        options={options}
        disabled={disabled}
        onChange={(next) => {
          setCustom(next === CUSTOM);
          if (next !== CUSTOM) onChange(next || null);
        }}
      />
      {custom ? (
        <CommitInput
          label="Format code"
          value={value ?? ""}
          placeholder="#,##0.0"
          disabled={disabled}
          onCommit={(code) => onChange(code.trim() || null)}
        />
      ) : null}
    </>
  );
}

/** Colours a series can take, light enough and dark enough to read on either theme. */
const SWATCHES = [
  "#3B82F6",
  "#F97316",
  "#10B981",
  "#EF4444",
  "#8B5CF6",
  "#EAB308",
  "#06B6D4",
  "#EC4899",
  "#64748B",
  "#1E293B",
] as const;

/** A series colour: automatic from the palette, a swatch, or any colour. */
export function ColorField({
  label,
  value,
  automatic,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string | undefined;
  /** What automatic draws, shown in the button. */
  automatic: string;
  onChange: (color: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={<Button size="icon-sm" variant="ghost" aria-label={label} disabled={disabled} />}
      >
        <span
          className="border-border size-4 rounded-full border"
          style={{ backgroundColor: value ?? automatic }}
        />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56">
        <div className="flex flex-col gap-3">
          <Button size="sm" variant={value ? "ghost" : "secondary"} onClick={() => onChange(null)}>
            Automatic
          </Button>
          <div className="grid grid-cols-5 gap-2">
            {SWATCHES.map((swatch) => (
              <button
                key={swatch}
                type="button"
                aria-label={swatch}
                aria-pressed={value?.toUpperCase() === swatch}
                className={cn(
                  "ring-offset-background size-7 rounded-full outline-none focus-visible:ring-2",
                  value?.toUpperCase() === swatch && "ring-ring ring-2 ring-offset-2",
                )}
                style={{ backgroundColor: swatch }}
                onClick={() => onChange(swatch)}
              />
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-muted-foreground text-xs">Custom</span>
            <ColorPicker value={value} onChange={onChange} />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A group of options that folds away. */
export function Section({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="border-border border-b">
      <Collapsible defaultOpen={defaultOpen}>
        <Button
          variant="ghost"
          className="group my-1 w-full justify-between"
          render={<CollapsibleTrigger />}
        >
          {title}
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            strokeWidth={2}
            className="text-muted-foreground transition-transform group-data-panel-open:rotate-180"
          />
        </Button>
        <CollapsibleContent>
          <div className="flex flex-col gap-4 pt-2 pb-4">{children}</div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
