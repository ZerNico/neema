import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useNavigate } from "@tanstack/react-router";
import { createContext, use, useEffect, useState, type ReactNode } from "react";
import { Button } from "~/ui/primitives/button";
import { Dialog, DialogOverlay, DialogPortal } from "~/ui/primitives/dialog";
import { Kbd } from "~/ui/primitives/kbd";
import { Spinner } from "~/ui/primitives/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import type { SearchGroup, SearchItem } from "../registry.ts";
import { useSearchGroups } from "../sources.ts";
import { MAX_SEARCH_LENGTH, type Snippet } from "../text.ts";

const PaletteContext = createContext<((open: boolean) => void) | null>(null);

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/**
 * Owns the palette's open state for the whole signed-in app, so Cmd/Ctrl+K
 * works from anywhere, the composer included, and the header button opens
 * the same instance.
 */
export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || event.shiftKey || event.altKey) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setOpen((current) => !current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <PaletteContext value={setOpen}>
      {children}
      <CommandPalette open={open} onOpenChange={setOpen} />
    </PaletteContext>
  );
}

/** The header's way in, beside the sidebar toggle. */
export function SearchButton() {
  const setOpen = use(PaletteContext);
  if (!setOpen) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Search"
            onClick={() => setOpen(true)}
          />
        }
      >
        <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
      </TooltipTrigger>
      <TooltipContent>
        Search <Kbd>{isMac() ? "⌘K" : "Ctrl K"}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [input, setInput] = useState("");
  const navigate = useNavigate();
  const { groups, pending } = useSearchGroups(input, open);

  const choose = (item: SearchItem) => {
    onOpenChange(false);
    if (item.run) item.run();
    else if (item.href) void navigate({ href: item.href });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) setInput("");
      }}
    >
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Popup
          aria-label="Search"
          className="bg-popover text-popover-foreground ring-foreground/5 dark:ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 fixed top-[12dvh] left-1/2 z-50 flex max-h-[76dvh] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 flex-col overflow-hidden rounded-3xl text-sm shadow-xl ring-1 duration-100 outline-none sm:max-w-xl"
        >
          <Autocomplete.Root
            open
            inline
            items={groups}
            value={input}
            onValueChange={setInput}
            // Every source matches for itself, locally or on the server.
            filter={null}
            itemToStringValue={(item: SearchItem) => item.label}
            autoHighlight="always"
            keepHighlight
          >
            <div className="flex items-center gap-2 border-b px-4">
              <HugeiconsIcon
                icon={Search01Icon}
                strokeWidth={2}
                className="text-muted-foreground size-4 shrink-0"
                aria-hidden
              />
              <Autocomplete.Input
                aria-label="Search"
                maxLength={MAX_SEARCH_LENGTH}
                placeholder="Search chats, agents, pages… or type > for actions"
                className="placeholder:text-muted-foreground h-12 min-w-0 flex-1 bg-transparent outline-none"
              />
              {pending ? <Spinner className="text-muted-foreground shrink-0" /> : null}
            </div>
            <div className="min-h-0 overflow-y-auto p-2">
              <Autocomplete.Empty>
                <p className="text-muted-foreground px-3 py-8 text-center">
                  {pending ? "Searching…" : "Nothing found"}
                </p>
              </Autocomplete.Empty>
              <Autocomplete.List>
                {(group: SearchGroup) => (
                  <Autocomplete.Group key={group.value} items={group.items} className="py-1">
                    <Autocomplete.GroupLabel className="text-muted-foreground px-3 pt-1 pb-1.5 text-xs font-medium">
                      {group.value}
                    </Autocomplete.GroupLabel>
                    <Autocomplete.Collection>
                      {(item: SearchItem) => (
                        <Autocomplete.Item
                          key={item.id}
                          value={item}
                          onClick={() => choose(item)}
                          className="data-highlighted:bg-accent data-highlighted:text-accent-foreground flex cursor-default items-start gap-3 rounded-2xl px-3 py-2 outline-none select-none"
                        >
                          <HugeiconsIcon
                            icon={item.icon}
                            strokeWidth={2}
                            className="text-muted-foreground mt-0.5 size-4 shrink-0"
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">
                              {item.label}
                              {/* A snippet takes the second line; the detail still shows. */}
                              {item.snippet && item.detail ? (
                                <span className="text-muted-foreground ml-2 text-xs font-normal">
                                  {item.detail}
                                </span>
                              ) : null}
                            </span>
                            {item.snippet ? (
                              <SnippetText snippet={item.snippet} />
                            ) : item.detail ? (
                              <span className="text-muted-foreground block truncate text-xs">
                                {item.detail}
                              </span>
                            ) : null}
                          </span>
                        </Autocomplete.Item>
                      )}
                    </Autocomplete.Collection>
                  </Autocomplete.Group>
                )}
              </Autocomplete.List>
            </div>
          </Autocomplete.Root>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}

/** The matched excerpt, its matches emphasised; two lines at most. */
function SnippetText({ snippet }: { snippet: Snippet }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of snippet.highlights) {
    if (start > at) parts.push(snippet.text.slice(at, start));
    parts.push(
      <mark key={start} className="text-foreground bg-transparent font-semibold">
        {snippet.text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  parts.push(snippet.text.slice(at));
  return (
    <span className="text-muted-foreground line-clamp-2 text-xs leading-relaxed">{parts}</span>
  );
}
