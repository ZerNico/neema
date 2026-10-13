import { AiImageIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "~/ui/primitives/dropdown-menu";
import { imageModelsQuery } from "../client/queries.ts";

/**
 * Which image model this chat draws with, as a submenu of the composer's plus
 * menu: it rarely changes, so it does not hold a place beside the chat model.
 * The chat keeps what it last used; a model that went away shows the one the
 * next answer falls back to, in the server's order (`resolveImageModel`): this
 * pick, the chat's lock, the agent's preference, then the admin's first.
 * Hidden when there is nothing to choose from.
 */
export function ImageModelMenu({
  value,
  lock = null,
  agentPreference = null,
  onChange,
  disabled = false,
}: {
  /** What the person picked for the next send; null when they have not. */
  value: string | null;
  lock?: string | null | undefined;
  agentPreference?: string | null | undefined;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}) {
  const { data: models = [] } = useQuery(imageModelsQuery);
  if (models.length === 0) return null;
  const usable = (id: string | null) => models.find((model) => model.id === id);
  const selected = usable(value) ?? usable(lock) ?? usable(agentPreference) ?? models[0]!;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        <HugeiconsIcon icon={AiImageIcon} strokeWidth={2} />
        {/* The label keeps its line; only the model's name gives way. */}
        <span className="shrink-0">Image model</span>
        <span className="text-muted-foreground ml-auto min-w-0 truncate pl-2 text-xs">
          {selected.displayName}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-72">
        <DropdownMenuRadioGroup value={selected.id} onValueChange={onChange}>
          {models.map((model) => (
            <DropdownMenuRadioItem key={model.id} value={model.id} closeOnClick>
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
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
