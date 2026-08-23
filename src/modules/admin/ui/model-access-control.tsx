import { GlobeIcon, SquareLock02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { listModelAccess, updateModelAccess } from "../server/functions.ts";
import { groupsQuery } from "./groups-page.tsx";
import { Button } from "~/ui/primitives/button";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "~/ui/primitives/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Field, FieldLabel } from "~/ui/primitives/field";
import { Switch } from "~/ui/primitives/switch";

export const modelAccessQuery = queryOptions({
  queryKey: ["admin", "model-access"],
  queryFn: () => listModelAccess(),
});

interface PickableGroup {
  id: string;
  name: string;
}

/**
 * The per-model access editor on the provider detail page: a compact trigger
 * stating the current audience, opening a dialog with the public/private
 * switch and — when private — the allowed-groups chip picker.
 */
export function ModelAccessControl({
  modelId,
  modelName,
  access,
}: {
  modelId: string;
  modelName: string;
  access: "public" | "groups";
}) {
  const { data: groups } = useSuspenseQuery(groupsQuery);
  const { data: accessRows } = useSuspenseQuery(modelAccessQuery);
  const [open, setOpen] = useState(false);

  const allowedIds = accessRows.filter((row) => row.modelId === modelId).map((row) => row.groupId);
  const label =
    access === "public"
      ? "Public"
      : allowedIds.length === 0
        ? "No groups yet"
        : allowedIds.length === 1
          ? "1 group"
          : `${allowedIds.length} groups`;

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="text-muted-foreground h-7 gap-1.5 px-2 text-xs"
        aria-label={`Access for ${modelName}: ${label}`}
        onClick={() => setOpen(true)}
      >
        <HugeiconsIcon
          icon={access === "public" ? GlobeIcon : SquareLock02Icon}
          className="size-3.5"
        />
        {label}
      </Button>
      {open ? (
        <AccessDialog
          modelId={modelId}
          modelName={modelName}
          initialAccess={access}
          initialGroups={groups.filter((group) => allowedIds.includes(group.id))}
          allGroups={groups}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

// Mounted per open so the draft state starts fresh from the saved values.
function AccessDialog({
  modelId,
  modelName,
  initialAccess,
  initialGroups,
  allGroups,
  onClose,
}: {
  modelId: string;
  modelName: string;
  initialAccess: "public" | "groups";
  initialGroups: PickableGroup[];
  allGroups: PickableGroup[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [restricted, setRestricted] = useState(initialAccess === "groups");
  const [selected, setSelected] = useState<PickableGroup[]>(initialGroups);
  const anchor = useComboboxAnchor();

  const save = useMutation({
    mutationFn: () =>
      updateModelAccess({
        data: {
          modelId,
          access: restricted ? "groups" : "public",
          groupIds: restricted ? selected.map((group) => group.id) : [],
        },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin"] }),
        // Visibility changed for someone — every picker must refetch.
        queryClient.invalidateQueries({ queryKey: ["chat-models"] }),
      ]);
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Who can use {modelName}?</DialogTitle>
          <DialogDescription>
            Public models are available to everyone. Private ones only to the selected groups —
            admins always keep access.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Restrict to groups</span>
            <Switch checked={restricted} onCheckedChange={setRestricted} />
          </label>
          {restricted ? (
            <Field>
              <FieldLabel>Allowed groups</FieldLabel>
              <Combobox
                multiple
                items={allGroups}
                value={selected}
                onValueChange={(next: PickableGroup[]) => setSelected(next)}
                itemToStringLabel={(group: PickableGroup) => group.name}
                isItemEqualToValue={(a: PickableGroup, b: PickableGroup) => a.id === b.id}
                filter={(group: PickableGroup, query: string) =>
                  group.name.toLowerCase().includes(query.trim().toLowerCase())
                }
                autoHighlight
              >
                <ComboboxChips ref={anchor}>
                  <ComboboxValue>
                    {(value: PickableGroup[]) => (
                      <>
                        {value.map((group) => (
                          <ComboboxChip key={group.id} aria-label={group.name}>
                            {group.name}
                          </ComboboxChip>
                        ))}
                        <ComboboxChipsInput placeholder={value.length ? "" : "Add groups…"} />
                      </>
                    )}
                  </ComboboxValue>
                </ComboboxChips>
                <ComboboxContent anchor={anchor} side="bottom">
                  <ComboboxEmpty>
                    {allGroups.length === 0 ? "No groups exist yet" : "No groups match"}
                  </ComboboxEmpty>
                  <ComboboxList>
                    {(group: PickableGroup) => (
                      <ComboboxItem key={group.id} value={group}>
                        {group.name}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
              {selected.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  Visible to admins only until a group is added.
                </p>
              ) : null}
            </Field>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={() => save.mutate()} disabled={save.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
