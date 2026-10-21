import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { readServerError } from "~/server-error.ts";
import { toastError } from "~/ui/error-toast.ts";
import { ListCard, ListRow, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import { Checkbox } from "~/ui/primitives/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Field, FieldError, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { storageQuotasQuery } from "../client/queries.ts";
import { formatBytes } from "../rules.ts";
import { setEveryoneStorage, setGroupStorage } from "../server/functions.ts";

const GB = 1024 ** 3;

const describe = (bytes: number | null) => (bytes === null ? "No quota" : formatBytes(bytes));

/**
 * What a person may store: everyone's quota, or on a group's page what this
 * group changes of it. Every file a person owns counts once.
 */
export function StorageQuotaSection({ groupId }: { groupId: string | null }) {
  const { data } = useQuery(storageQuotasQuery);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: storageQuotasQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: ["my-storage"] }),
    ]);
  const reset = useMutation({
    mutationFn: () => setGroupStorage({ data: { groupId: groupId! } }),
    onSuccess: refresh,
    onError: (error) => toastError("Could not change the quota.", error),
  });
  if (!data) return null;
  const everyone = data.everyone;
  const own = groupId === null ? undefined : data.groups.find((row) => row.groupId === groupId);

  return (
    <Section
      title="Storage"
      description={
        groupId === null
          ? "What each person but admins may store, unless their group changes it."
          : "What this group’s members may store."
      }
    >
      <ListCard>
        <ListRow className="flex-wrap">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">{describe(own ? own.bytes : everyone)}</span>
            {groupId !== null ? (
              <span className="text-muted-foreground text-xs">
                {own ? `Everyone else: ${describe(everyone)}` : "Everyone’s quota"}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              {groupId !== null && !own ? "Change for this group" : "Edit"}
            </Button>
            {own ? (
              <PendingButton
                size="sm"
                variant="ghost"
                pending={reset.isPending}
                onClick={() => reset.mutate()}
              >
                Use everyone’s
              </PendingButton>
            ) : null}
          </div>
        </ListRow>
      </ListCard>
      {editing ? (
        <QuotaDialog
          groupId={groupId}
          bytes={own ? own.bytes : everyone}
          onOpenChange={setEditing}
          onSaved={refresh}
        />
      ) : null}
    </Section>
  );
}

function QuotaDialog({
  groupId,
  bytes,
  onOpenChange,
  onSaved,
}: {
  groupId: string | null;
  bytes: number | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<unknown>;
}) {
  const fieldId = useId();
  const shown = bytes === null ? "" : String(Math.round((bytes / GB) * 100) / 100);
  const [size, setSize] = useState(shown);
  const [unlimited, setUnlimited] = useState(bytes === null);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      // Untouched, it keeps its exact size rather than the rounded one shown.
      const value = unlimited
        ? null
        : size === shown && bytes !== null
          ? bytes
          : Math.round(Number(size) * GB);
      return groupId === null
        ? setEveryoneStorage({ data: { bytes: value } })
        : setGroupStorage({ data: { groupId, bytes: value } });
    },
    onSuccess: async () => {
      await onSaved();
      onOpenChange(false);
    },
    onError: (failure) => setError(readServerError(failure).reason ?? "Could not save the quota."),
  });
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{groupId === null ? "Storage quota" : "Storage for this group"}</DialogTitle>
          <DialogDescription>
            Uploads stop once it is full. Files an answer makes are still kept.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            save.mutate();
          }}
        >
          <Field>
            <FieldLabel htmlFor={`${fieldId}-size`}>Size in GB</FieldLabel>
            <Input
              id={`${fieldId}-size`}
              type="number"
              inputMode="decimal"
              min={0.01}
              step={0.01}
              value={size}
              disabled={unlimited}
              onChange={(event) => setSize(event.target.value)}
            />
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={unlimited} onCheckedChange={(on) => setUnlimited(Boolean(on))} />
              {groupId === null ? "No quota" : "No quota for this group"}
            </label>
          </Field>
          {error ? <FieldError>{error}</FieldError> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
              Cancel
            </DialogClose>
            <PendingButton
              type="submit"
              pending={save.isPending}
              disabled={!unlimited && !(Number(size) > 0)}
            >
              Save
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
