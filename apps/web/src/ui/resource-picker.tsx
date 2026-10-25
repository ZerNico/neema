import { useState } from "react";
import { Button } from "~/ui/primitives/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "~/ui/primitives/combobox";
import { m } from "~/paraglide/messages.js";

export interface ResourcePickerItem {
  id: string;
  name: string;
  description: string;
}

/**
 * Multi-select over a list of pickable resources (skills, custom tools):
 * type to filter, tick rows, commit with Add. The draft is local until Add,
 * so closing the popover discards an unfinished selection.
 */
export function ResourcePicker({
  items,
  selectedIds,
  onChange,
  open,
  onOpenChange,
  anchor,
  side = "top",
  limit,
  placeholder,
  empty,
  detail,
}: {
  items: readonly ResourcePickerItem[];
  selectedIds: readonly string[];
  onChange: (ids: string[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: HTMLElement | null;
  /** Open where the menu that led here opened, so the pointer need not cross the page. */
  side?: "top" | "bottom";
  limit: number;
  placeholder: string;
  empty: string;
  /** Optional suffix in a row's description line, e.g. an owner name. */
  detail?: (item: ResourcePickerItem) => string | null;
}) {
  const [draft, setDraft] = useState<string[] | null>(null);
  const ids = draft ?? selectedIds;
  return (
    <Combobox
      multiple
      open={open}
      onOpenChange={(next) => {
        if (!next) setDraft(null);
        onOpenChange(next);
      }}
      items={[...items]}
      value={items.filter((item) => ids.includes(item.id))}
      onValueChange={(next: ResourcePickerItem[]) => setDraft(next.map((item) => item.id))}
      itemToStringLabel={(item: ResourcePickerItem) => item.name}
      isItemEqualToValue={(a: ResourcePickerItem, b: ResourcePickerItem) => a.id === b.id}
      filter={(item: ResourcePickerItem, query: string) =>
        `${item.name} ${item.description} ${detail?.(item) ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase())
      }
      autoHighlight
    >
      <ComboboxContent side={side} anchor={anchor} className="w-72 max-w-[calc(100vw-24px)]">
        <ComboboxInput placeholder={placeholder} showTrigger={false} aria-label={placeholder} />
        <ComboboxEmpty>{empty}</ComboboxEmpty>
        <ComboboxList>
          {(item: ResourcePickerItem) => {
            const suffix = detail?.(item);
            return (
              <ComboboxItem
                key={item.id}
                value={item}
                disabled={!ids.includes(item.id) && ids.length >= limit}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{item.name}</span>
                  <span className="text-muted-foreground block truncate text-xs font-normal">
                    {item.description}
                    {suffix ? ` · ${suffix}` : ""}
                  </span>
                </span>
              </ComboboxItem>
            );
          }}
        </ComboboxList>
        <div className="flex items-center gap-2 border-t px-3 py-2">
          <span className="text-muted-foreground flex-1 text-xs">
            {m.ui_picker_selected({ count: ids.length, limit })}
          </span>
          <Button
            size="sm"
            onClick={() => {
              onChange([...ids]);
              setDraft(null);
              onOpenChange(false);
            }}
          >
            {m.common_add()}
          </Button>
        </div>
      </ComboboxContent>
    </Combobox>
  );
}
