import { File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { matchesWords } from "~/modules/search/match.ts";
import { m } from "~/paraglide/messages.js";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "~/ui/primitives/combobox";
import { documentLibraryQuery } from "../client/document-queries.ts";
import type { LibraryDocument } from "../schema.ts";

/**
 * Searchable popup of the person's own documents for the composer's "+" menu.
 * A pick names the document in the message, which adds it to the chat.
 */
export function DocumentPicker({
  open,
  onOpenChange,
  anchor,
  side,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: HTMLElement | null;
  side: "top" | "bottom";
  onPick: (document: LibraryDocument) => void;
}) {
  const library = useQuery({ ...documentLibraryQuery, enabled: open });
  const items = library.data ?? [];
  return (
    <Combobox
      open={open}
      onOpenChange={onOpenChange}
      items={items}
      value={null}
      onValueChange={(document: LibraryDocument | null) => {
        if (document) onPick(document);
        onOpenChange(false);
      }}
      itemToStringLabel={(document: LibraryDocument) => document.title}
      isItemEqualToValue={(a: LibraryDocument, b: LibraryDocument) => a.id === b.id}
      filter={(document: LibraryDocument, query: string) =>
        matchesWords(`${document.title} ${document.conversationTitle ?? ""}`, query)
      }
      autoHighlight
    >
      <ComboboxContent side={side} anchor={anchor} className="w-72 min-w-72">
        <ComboboxInput
          placeholder={m.chat_document_picker_search()}
          showTrigger={false}
          aria-label={m.chat_document_picker_title()}
        />
        <ComboboxEmpty>
          {library.isPending
            ? m.documents_library_loading()
            : library.isError
              ? m.documents_library_load_failed()
              : m.chat_document_picker_empty()}
        </ComboboxEmpty>
        <ComboboxList>
          {(document: LibraryDocument) => (
            <ComboboxItem key={document.id} value={document}>
              <HugeiconsIcon icon={File01Icon} strokeWidth={2} />
              <span className="min-w-0 flex-1 truncate">{document.title}</span>
              {document.conversationTitle ? (
                <span className="text-muted-foreground truncate text-xs font-normal">
                  {document.conversationTitle}
                </span>
              ) : null}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
