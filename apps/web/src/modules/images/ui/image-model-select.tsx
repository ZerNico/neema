import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ListRow } from "~/ui/page-shell.tsx";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { imageModelsQuery } from "../client/queries.ts";
import { m } from "~/paraglide/messages.js";

const NONE = "none";

/**
 * A saved preference for the image model (an agent's, a schedule's): one
 * settings row beside the preferred chat model, and drawn like it. Hidden while
 * there is nothing to draw with; a saved model the person can no longer use
 * still shows, named as unavailable.
 */
export function ImageModelSettingRow({
  value,
  onChange,
  description,
}: {
  value: string | null | undefined;
  onChange: (modelId: string | null) => void;
  description: string;
}) {
  const { data: models = [] } = useQuery(imageModelsQuery);
  const [open, setOpen] = useState(false);
  if (models.length === 0 && !value) return null;
  const selected = models.find((model) => model.id === value);
  const label =
    selected?.displayName ??
    (value ? m.images_setting_unavailable() : m.images_setting_no_preference());
  return (
    // Wraps in the narrow rail: the label keeps its line and the picker takes the rest.
    <ListRow className="flex-wrap">
      <div className="flex min-w-24 shrink-0 flex-col">
        <span className="text-sm font-medium">{m.images_setting_title()}</span>
        <span className="text-muted-foreground text-xs">{description}</span>
      </div>
      <div className="flex min-w-0 flex-1 justify-end">
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger
            render={
              <Button
                size="sm"
                variant="outline"
                className="w-full min-w-0 justify-between"
                aria-label={m.images_setting_title()}
              />
            }
          >
            <span className="truncate">{label}</span>
            <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuRadioGroup
              value={value ?? NONE}
              onValueChange={(next) => {
                onChange(next === NONE ? null : next);
                setOpen(false);
              }}
            >
              <DropdownMenuRadioItem value={NONE}>
                {m.images_setting_no_preference()}
              </DropdownMenuRadioItem>
              {models.map((model) => (
                <DropdownMenuRadioItem key={model.id} value={model.id}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{model.displayName}</span>
                    {model.description ? (
                      <span className="text-muted-foreground truncate text-xs">
                        {model.description}
                      </span>
                    ) : null}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </ListRow>
  );
}
