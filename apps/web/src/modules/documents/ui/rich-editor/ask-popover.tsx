import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { useId, useState } from "react";
import { Button } from "~/ui/primitives/button";
import { Field, FieldError, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Popover, PopoverContent } from "~/ui/primitives/popover";
import { editorHooks } from "./editor-hooks.ts";

/**
 * Asks the assistant to write at one spot. The "/" item plants an empty
 * planned section and selects it; this opens on it. Sending writes the
 * request into the section and sends it as a chat message with that section
 * selected, which the model fills. Cancelling removes the empty section.
 */
export function AskPopover({ editor }: { editor: Editor }) {
  const id = useId();
  const [request, setRequest] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const position = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const { selection } = current.state;
      return selection instanceof NodeSelection &&
        selection.node.type.name === "pending" &&
        !selection.node.attrs.intent
        ? selection.from
        : null;
    },
  });
  const anchor = position === null ? null : (editor.view.nodeDOM(position) as Element | null);
  const ask = editorHooks(editor).ask;
  const close = () => {
    setRequest("");
    setError(null);
    const node = position === null ? null : editor.state.doc.nodeAt(position);
    // Still an empty planned section: nothing was asked, so it goes.
    if (node?.type.name === "pending" && !node.attrs.intent)
      editor
        .chain()
        .focus()
        .deleteRange({ from: position!, to: position! + node.nodeSize })
        .run();
  };
  const send = async () => {
    const text = request.trim();
    if (!text || position === null || !ask) return;
    setSending(true);
    editor
      .chain()
      .command(({ tr }) => {
        tr.setNodeAttribute(position, "intent", text.slice(0, 200));
        return true;
      })
      .run();
    // Named now: by the time the message goes out, focus has left this spot.
    const id = editor.state.doc.nodeAt(position)?.attrs.id as string | undefined;
    const sent = await ask(text, id ? [id] : []).catch(() => false);
    setSending(false);
    if (!sent) {
      // Put it back as an open question rather than leave a request nobody sent.
      editor
        .chain()
        .command(({ tr }) => {
          tr.setNodeAttribute(position, "intent", "");
          return true;
        })
        .run();
      setError("Wait for the current answer to finish, then ask again.");
      return;
    }
    setRequest("");
    setError(null);
  };
  return (
    <Popover
      open={anchor !== null && ask !== null}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <PopoverContent anchor={anchor} align="start" className="w-80">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor={id}>Ask the assistant to write here</FieldLabel>
            <Input
              id={id}
              autoFocus
              value={request}
              placeholder="A short intro on the budget"
              onChange={(event) => setRequest(event.target.value)}
            />
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
          <Button type="submit" size="sm" disabled={!request.trim() || sending}>
            Ask
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
