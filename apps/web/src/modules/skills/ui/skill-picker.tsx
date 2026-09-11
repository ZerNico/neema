import { useState } from "react";
import type { SkillSummary } from "../schema.ts";
import { Button } from "~/ui/primitives/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "~/ui/primitives/combobox";

export function SkillPicker({
  items,
  selectedIds,
  onChange,
  open,
  onOpenChange,
  anchor,
  limit = 5,
}: {
  items: readonly SkillSummary[];
  selectedIds: readonly string[];
  onChange: (ids: string[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: HTMLElement | null;
  limit?: number;
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
      value={items.filter((skill) => ids.includes(skill.id))}
      onValueChange={(next: SkillSummary[]) => setDraft(next.map((skill) => skill.id))}
      itemToStringLabel={(skill: SkillSummary) => skill.name}
      isItemEqualToValue={(a: SkillSummary, b: SkillSummary) => a.id === b.id}
      filter={(skill: SkillSummary, query: string) =>
        `${skill.name} ${skill.description} ${skill.ownerName ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase())
      }
      autoHighlight
    >
      <ComboboxContent side="top" anchor={anchor} className="w-72 max-w-[calc(100vw-24px)]">
        <ComboboxInput placeholder="Search your skills…" showTrigger={false} aria-label="Skills" />
        <ComboboxEmpty>No matching local skills.</ComboboxEmpty>
        <ComboboxList>
          {(skill: SkillSummary) => (
            <ComboboxItem
              key={skill.id}
              value={skill}
              disabled={!ids.includes(skill.id) && ids.length >= limit}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{skill.name}</span>
                <span className="text-muted-foreground block truncate text-xs font-normal">
                  {skill.description}
                  {skill.ownerName ? ` · ${skill.ownerName}` : ""}
                </span>
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
        <div className="flex items-center gap-2 border-t px-3 py-2">
          <span className="text-muted-foreground flex-1 text-xs">
            {ids.length} selected · up to {limit}
          </span>
          <Button
            size="sm"
            onClick={() => {
              onChange([...ids]);
              setDraft(null);
              onOpenChange(false);
            }}
          >
            Add
          </Button>
        </div>
      </ComboboxContent>
    </Combobox>
  );
}
