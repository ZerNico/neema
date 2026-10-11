import { Delete02Icon, LinkSquare02Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Field, FieldError, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { linkOf } from "./link.ts";

/**
 * Excel's Insert Hyperlink for the selection: the address it opens and, for
 * a cell holding a value rather than a formula, the text it shows.
 */
export function LinkDialog({
  text,
  link,
  textEditable,
  onApply,
  onClose,
}: {
  text: string;
  link: string | undefined;
  textEditable: boolean;
  /** The text to show, unchanged when null, and the link, or null to remove it. */
  onApply: (change: { text: string | null; link: string | null }) => void;
  onClose: () => void;
}) {
  const [shown, setShown] = useState(text);
  const [address, setAddress] = useState(link ?? "");
  const read = linkOf(address);
  const invalid = address.trim() !== "" && read === null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{link ? "Edit link" : "Insert link"}</DialogTitle>
          <DialogDescription>A web or mail address the cells open.</DialogDescription>
        </DialogHeader>
        <form
          id="sheet-link"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (invalid) return;
            onApply({ text: textEditable && shown !== text ? shown : null, link: read });
            onClose();
          }}
        >
          {textEditable ? (
            <Field>
              <FieldLabel htmlFor="sheet-link-text">Text</FieldLabel>
              <Input
                id="sheet-link-text"
                value={shown}
                onChange={(event) => setShown(event.target.value)}
              />
            </Field>
          ) : null}
          <Field data-invalid={invalid || undefined}>
            <FieldLabel htmlFor="sheet-link-address">Link</FieldLabel>
            <Input
              id="sheet-link-address"
              autoFocus
              placeholder="example.com"
              aria-invalid={invalid || undefined}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
            {invalid ? <FieldError>Use a web or mail address.</FieldError> : null}
          </Field>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="sheet-link" disabled={invalid}>
            {address.trim() === "" && link ? "Remove link" : "OK"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Under a linked cell, as Google Sheets shows one: the address to open, edit or remove. */
export function LinkChip({
  link,
  readOnly,
  onEdit,
  onRemove,
}: {
  link: string;
  readOnly: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="bg-popover text-popover-foreground border-border flex max-w-80 items-center gap-1 rounded-md border p-1 shadow-md">
      <Button
        size="xs"
        variant="link"
        className="min-w-0"
        render={<a href={link} target="_blank" rel="noopener noreferrer" />}
      >
        <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} />
        <span className="truncate">{link.replace(/^mailto:/, "")}</span>
      </Button>
      {readOnly ? null : (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button size="icon-xs" variant="ghost" aria-label="Edit link" onClick={onEdit} />
              }
            >
              <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
            </TooltipTrigger>
            <TooltipContent>Edit link</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Remove link"
                  onClick={onRemove}
                />
              }
            >
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            </TooltipTrigger>
            <TooltipContent>Remove link</TooltipContent>
          </Tooltip>
        </>
      )}
    </div>
  );
}
