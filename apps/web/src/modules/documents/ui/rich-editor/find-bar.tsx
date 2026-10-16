import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  MoreVerticalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useState } from "react";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Input } from "~/ui/primitives/input";
import {
  findState,
  goToMatch,
  replaceAll,
  replaceCurrent,
  search,
  setFindOpen,
  type FindOptions,
} from "./find.ts";

/**
 * Find and replace over a document, above its text: the query, which match is
 * current of how many, and steps; replacing too for someone who may edit.
 * Matches stay highlighted as the text changes, someone else's edits included.
 */
export function DocumentFindBar({ editor }: { editor: Editor }) {
  const find = useEditorState({
    editor,
    selector: ({ editor: current }) => findState(current.state),
  });
  if (!find.open) return null;
  return (
    <OpenFindBar key={String(find.open)} editor={editor} replacing={find.open === "replace"} />
  );
}

function OpenFindBar({ editor, replacing }: { editor: Editor; replacing: boolean }) {
  const find = useEditorState({
    editor,
    selector: ({ editor: current }) => findState(current.state),
  });
  // Opening may have searched for the selected words already.
  const [query, setQuery] = useState(find.query);
  const [replacement, setReplacement] = useState("");
  const [replaced, setReplaced] = useState<number | null>(null);
  const editable = editor.isEditable;
  const count = find.matches.length;
  const close = () => {
    setFindOpen(editor, false);
    editor.commands.focus();
  };
  const searchFor = (next: string, options: FindOptions = find.options) => {
    setQuery(next);
    setReplaced(null);
    search(editor, next, options);
  };
  const keys = (event: React.KeyboardEvent<HTMLInputElement>, onEnter: () => void) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onEnter();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };
  return (
    <div
      role="search"
      aria-label="Find in document"
      className="border-border shrink-0 border-b px-3"
    >
      <div className="flex h-9 items-center gap-1">
        <Input
          autoFocus
          aria-label="Find in document"
          placeholder="Find in document"
          value={query}
          // oxlint-disable-next-line shadcn/no-restyle -- sits flat in its row, as the bar's other controls do.
          className="h-7 border-0 text-xs shadow-none focus-visible:ring-0"
          onChange={(event) => searchFor(event.target.value)}
          onKeyDown={(event) =>
            keys(event, () => goToMatch(editor, find.index + (event.shiftKey ? -1 : 1)))
          }
        />
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {replaced !== null
            ? `Replaced ${replaced}`
            : query
              ? count
                ? `${find.index + 1} of ${count}`
                : "No matches"
              : ""}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button size="icon-xs" variant="ghost" aria-label="Find options" />}
          >
            <HugeiconsIcon icon={MoreVerticalIcon} strokeWidth={2} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuCheckboxItem
              checked={find.options.caseSensitive}
              onCheckedChange={(checked) =>
                searchFor(query, { ...find.options, caseSensitive: checked })
              }
            >
              Match case
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={find.options.wholeWord}
              onCheckedChange={(checked) =>
                searchFor(query, { ...find.options, wholeWord: checked })
              }
            >
              Whole words only
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Previous match"
          disabled={!count}
          onClick={() => goToMatch(editor, find.index - 1)}
        >
          <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={2} />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Next match"
          disabled={!count}
          onClick={() => goToMatch(editor, find.index + 1)}
        >
          <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Close find" onClick={close}>
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </div>
      {replacing && editable ? (
        <div className="flex h-9 items-center gap-1">
          <Input
            aria-label="Replace with"
            placeholder="Replace with"
            value={replacement}
            // oxlint-disable-next-line shadcn/no-restyle -- sits flat in its row, as the query does.
            className="h-7 border-0 text-xs shadow-none focus-visible:ring-0"
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => keys(event, () => replaceCurrent(editor, replacement))}
          />
          <Button
            size="xs"
            variant="ghost"
            disabled={!count}
            onClick={() => replaceCurrent(editor, replacement)}
          >
            Replace
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={!count}
            onClick={() => setReplaced(replaceAll(editor, replacement))}
          >
            Replace all
          </Button>
        </div>
      ) : null}
    </div>
  );
}
