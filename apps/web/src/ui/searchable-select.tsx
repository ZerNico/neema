import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "~/ui/utils";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "~/ui/primitives/combobox";

export interface SearchableOption {
  readonly value: string;
  readonly label: string;
  /** Muted text after the label, the same in the trigger and the list. */
  readonly detail?: string | null | undefined;
}

/** A row's label and its muted detail, laid out once for the trigger and the list alike. */
function OptionText({ option }: { option: SearchableOption }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="truncate">{option.label}</span>
      {option.detail ? (
        <span className="text-muted-foreground shrink-0 text-xs">{option.detail}</span>
      ) : null}
    </span>
  );
}

/**
 * A select whose list can be searched: the select's trigger, a search field
 * at the top of its popup. For lists that grow with what admins configure,
 * such as models, where a plain select becomes a long scroll.
 */
export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = "Choose…",
  emptyPlaceholder = "Nothing to choose from",
  searchPlaceholder = "Search…",
  noMatches = "No matches",
  disabled = false,
  id,
  "aria-label": ariaLabel,
  className,
}: {
  options: ReadonlyArray<SearchableOption>;
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  /** Shown when there are no options; the control is disabled then. */
  emptyPlaceholder?: string;
  searchPlaceholder?: string;
  noMatches?: string;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  className?: string;
}) {
  const selected = options.find((option) => option.value === value) ?? null;
  const empty = options.length === 0;
  return (
    <Combobox
      items={[...options]}
      value={selected}
      onValueChange={(next: SearchableOption | null) => onChange(next?.value ?? null)}
      itemToStringLabel={(option: SearchableOption) => option.label}
      isItemEqualToValue={(a: SearchableOption, b: SearchableOption) => a.value === b.value}
      filter={(option: SearchableOption, query: string) =>
        `${option.label} ${option.detail ?? ""}`.toLowerCase().includes(query.toLowerCase())
      }
      disabled={disabled || empty}
      autoHighlight
    >
      <ComboboxPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        data-placeholder={selected ? undefined : ""}
        className={cn(
          "bg-input/50 focus-visible:border-ring focus-visible:ring-ring/30 data-placeholder:text-muted-foreground flex h-9 w-full items-center justify-between gap-1.5 rounded-3xl border border-transparent px-3 py-2 text-left text-sm whitespace-nowrap transition-[color,box-shadow,background-color] outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      >
        {selected ? (
          <OptionText option={selected} />
        ) : (
          <span className="truncate">{empty ? emptyPlaceholder : placeholder}</span>
        )}
        <HugeiconsIcon
          icon={UnfoldMoreIcon}
          strokeWidth={2}
          className="text-muted-foreground pointer-events-none size-4 shrink-0"
        />
      </ComboboxPrimitive.Trigger>
      <ComboboxContent>
        <ComboboxInput
          placeholder={searchPlaceholder}
          showTrigger={false}
          aria-label={searchPlaceholder}
        />
        <ComboboxEmpty>{noMatches}</ComboboxEmpty>
        <ComboboxList>
          {(option: SearchableOption) => (
            <ComboboxItem key={option.value} value={option}>
              <OptionText option={option} />
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
