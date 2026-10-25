import { useMutation } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import { readServerError } from "~/server-error.ts";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { m } from "~/paraglide/messages.js";

/**
 * Naming or renaming something, the one way every page does it: the name is
 * trimmed and bounded, an unchanged one closes without a request, and a
 * refusal shows the server's reason, else `failure`.
 */
export function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  label = m.common_name(),
  initial = "",
  maxLength,
  placeholder,
  submitLabel,
  failure,
  onSubmit,
  changed = false,
  renderExtra,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  label?: string;
  /** The name as it is now; empty for something new. */
  initial?: string;
  maxLength: number;
  placeholder?: string;
  submitLabel: string;
  /** "Could not …", shown when the server gives no reason a person can use. */
  failure: string;
  /** Saves the trimmed name; the dialog closes once it resolves. */
  onSubmit: (name: string) => Promise<unknown>;
  /** Whether a field in `renderExtra` changed, so an unchanged name still saves. */
  changed?: boolean;
  /** More fields below the name, given whether a save is under way. */
  renderExtra?: (pending: boolean) => ReactNode;
}) {
  const id = useId();
  // Null until the person types, so the field shows the name as it is now.
  const [draft, setDraft] = useState<string | null>(null);
  const name = (draft ?? initial).trim();
  const save = useMutation({ mutationFn: onSubmit, onSuccess: () => close() });
  const close = () => {
    setDraft(null);
    save.reset();
    onOpenChange(false);
  };
  // The field stops typing at the bound; a longer name set some other way is caught here.
  const tooLong = name.length > maxLength;
  const error = tooLong
    ? m.ui_name_too_long({ max: maxLength })
    : save.isError
      ? (readServerError(save.error).reason ?? failure)
      : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else if (!save.isPending) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name || tooLong) return;
            if (initial && name === initial.trim() && !changed) close();
            else save.mutate(name);
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>{label}</FieldLabel>
              <Input
                id={`${id}-name`}
                value={draft ?? initial}
                maxLength={maxLength}
                placeholder={placeholder}
                onChange={(event) => {
                  setDraft(event.target.value);
                  if (save.isError) save.reset();
                }}
                disabled={save.isPending}
                autoFocus
                onFocus={(event) => event.currentTarget.select()}
              />
            </Field>
            {renderExtra?.(save.isPending)}
          </FieldGroup>
          {error ? <FieldError>{error}</FieldError> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
              {m.common_cancel()}
            </DialogClose>
            <PendingButton type="submit" pending={save.isPending} disabled={!name || tooLong}>
              {submitLabel}
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
