import { ResourcePicker } from "~/ui/resource-picker.tsx";
import type { SkillSummary } from "../schema.ts";

import { m } from "~/paraglide/messages.js";

export function SkillPicker({
  items,
  selectedIds,
  onChange,
  open,
  onOpenChange,
  anchor,
  side,
  limit = 5,
}: {
  items: readonly SkillSummary[];
  selectedIds: readonly string[];
  onChange: (ids: string[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: HTMLElement | null;
  side?: "top" | "bottom";
  limit?: number;
}) {
  return (
    <ResourcePicker
      items={items}
      selectedIds={selectedIds}
      onChange={onChange}
      open={open}
      onOpenChange={onOpenChange}
      anchor={anchor}
      {...(side ? { side } : {})}
      limit={limit}
      placeholder={m.skills_list_search_placeholder()}
      empty={m.skills_picker_empty()}
      detail={(skill) => (skill as SkillSummary).ownerName}
    />
  );
}
