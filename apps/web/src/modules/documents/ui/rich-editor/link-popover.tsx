import { m } from "~/paraglide/messages.js";
import type { Editor } from "@tiptap/core";
import { useId, useState } from "react";
import { Button } from "~/ui/primitives/button";
import { Field, FieldError, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Popover, PopoverContent } from "~/ui/primitives/popover";
import { linkTarget } from "./links.ts";

/**
 * Adds, changes or removes the link on the selection. It has no trigger of
 * its own: the toolbar, its More menu and the bubble menu each open it from
 * wherever the reader clicked.
 */
export function LinkPopover({
  editor,
  anchor,
  onClose,
}: {
  editor: Editor;
  /** Where it opens; null while closed. */
  anchor: Element | null;
  onClose: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [openedFor, setOpenedFor] = useState<Element | null>(null);
  // Opening reads the selection's link afresh, however it was opened.
  if (anchor !== openedFor) {
    setOpenedFor(anchor);
    if (anchor) {
      setValue((editor.getAttributes("link").href as string | undefined) ?? "");
      setInvalid(false);
    }
  }
  const active = editor.isActive("link");
  const apply = () => {
    const href = linkTarget(value);
    if (!href) {
      setInvalid(true);
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    onClose();
  };
  return (
    <Popover
      open={anchor !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <PopoverContent anchor={anchor} align="start">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <Field data-invalid={invalid || undefined}>
            <FieldLabel htmlFor={`${id}-href`}>{m.documents_link_address()}</FieldLabel>
            <Input
              id={`${id}-href`}
              value={value}
              autoFocus
              // oxlint-disable-next-line i18n/no-literal-text -- an address, the same in every language
              placeholder="https://example.com"
              aria-invalid={invalid || undefined}
              onChange={(event) => {
                setValue(event.target.value);
                setInvalid(false);
              }}
            />
            {invalid ? <FieldError>{m.documents_link_invalid()}</FieldError> : null}
          </Field>
          <div className="flex justify-end gap-2">
            {active ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  editor.chain().focus().extendMarkRange("link").unsetLink().run();
                  onClose();
                }}
              >
                {m.common_remove()}
              </Button>
            ) : null}
            <Button type="submit" size="sm">
              {active ? m.documents_link_update() : m.documents_link_add()}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
