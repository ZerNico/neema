import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import getCaretCoordinates from "textarea-caret";
import { matchMentionToken } from "~/ui/mention-token.ts";
import { Popover, PopoverContent } from "~/ui/primitives/popover";
import { cn } from "~/ui/utils";

/** One row of a mention list. Both lines are optional; only `label` shows always. */
export interface MentionItem {
  id: string;
  label: string;
  /** Muted suffix on the label line: an owner, a count. */
  meta?: string | undefined;
  /** Second line. */
  description?: string | undefined;
  /** What the typed query filters against; defaults to label plus description. */
  search?: string | undefined;
}

export interface MentionSource {
  /** The character that opens this list at the start of a word. */
  trigger: string;
  /** Accessible name for the listbox. */
  label: string;
  items: readonly MentionItem[];
  onSelect: (id: string) => void;
  /**
   * What replaces the typed token. Absent deletes it, for mentions that only
   * attach something; text keeps the mention in the message itself.
   */
  insertText?: ((item: MentionItem) => string) | undefined;
}

const MAX_RESULTS = 8;

/**
 * Type-ahead lists anchored to the caret of a textarea, one per trigger
 * character ("/" for skills, "#" for knowledge). Triggers are distinct, so at
 * most one list can be open: the sources are tried in order and the first whose
 * token matches at the caret wins.
 *
 * The whole thing is presentation over a caret position; it never owns the
 * textarea's value. Accepting a row deletes the token and hands the id back, so
 * what a selection *means* stays with the caller.
 */
export function useTextareaMentions(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  onChange: (value: string) => void,
  sources: readonly MentionSource[] = [],
) {
  const id = useId();
  const [selection, setSelection] = useState({ start: 0, end: 0, focused: false });
  const [dismissed, setDismissed] = useState<{ signature: string | null; value: string } | null>(
    null,
  );
  const [active, setActive] = useState<{ signature: string | null; index: number }>({
    signature: null,
    index: 0,
  });
  const [rect, setRect] = useState<{
    x: number;
    y: number;
    height: number;
    element: HTMLTextAreaElement | null;
  }>({ x: 0, y: 0, height: 24, element: null });

  const enabled = sources.length > 0;
  const hit = selection.focused
    ? sources.reduce<{ source: MentionSource; token: ReturnType<typeof matchMentionToken> } | null>(
        (found, source) => {
          if (found) return found;
          const token = matchMentionToken(value, selection.start, selection.end, source.trigger);
          return token ? { source, token } : null;
        },
        null,
      )
    : null;
  const token = hit?.token ?? null;
  const source = hit?.source ?? null;
  const signature =
    token && source ? `${source.trigger}${token.start}:${token.end}:${token.query}` : null;
  const results =
    token && source
      ? source.items
          .filter((item) =>
            (item.search ?? `${item.label} ${item.description ?? ""}`)
              .toLowerCase()
              .includes(token.query.toLowerCase()),
          )
          .slice(0, MAX_RESULTS)
      : [];
  // A dismissal outlives caret movement but not editing. Token signature alone
  // isn't enough: accepting a row deletes the token, and retyping the trigger
  // rebuilds a byte-identical signature, re-adding what was just removed. Clearing
  // it during render settles this before paint, where an effect would cost an
  // extra commit.
  if (dismissed && dismissed.value !== value) setDismissed(null);
  const open = !!token && dismissed?.signature !== signature && results.length > 0;
  const selectedIndex =
    active.signature === signature ? Math.min(active.index, Math.max(0, results.length - 1)) : 0;

  const syncSelection = () => {
    const textarea = ref.current;
    if (!textarea) return;
    setSelection({
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
      focused: document.activeElement === textarea,
    });
  };
  useEffect(() => {
    const textarea = ref.current;
    if (!textarea || !enabled) return;
    document.addEventListener("selectionchange", syncSelection);
    for (const event of ["focus", "blur", "select"])
      textarea.addEventListener(event, syncSelection);
    return () => {
      document.removeEventListener("selectionchange", syncSelection);
      for (const event of ["focus", "blur", "select"])
        textarea.removeEventListener(event, syncSelection);
    };
    // oxlint-disable-next-line exhaustive-deps -- syncSelection only reads refs and setState
  }, [ref, enabled]);
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea || !open) return;
    const measure = () => {
      const caret = getCaretCoordinates(textarea, textarea.selectionStart);
      const box = textarea.getBoundingClientRect();
      setRect({
        x: Math.min(box.right, Math.max(box.left, box.left + caret.left - textarea.scrollLeft)),
        y: Math.min(box.bottom, Math.max(box.top, box.top + caret.top - textarea.scrollTop)),
        height: caret.height,
        element: textarea,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(textarea);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    document.fonts?.addEventListener("loadingdone", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
      document.fonts?.removeEventListener("loadingdone", measure);
    };
  }, [open, value, selection.start, ref]);
  const anchor = useMemo(
    () => ({
      getBoundingClientRect: () => new DOMRect(rect.x, rect.y, 1, rect.height),
      ...(rect.element ? { contextElement: rect.element } : {}),
    }),
    [rect],
  );

  const accept = (index: number) => {
    const textarea = ref.current;
    const item = results[index];
    if (!textarea || !token || !source || !item) return;
    textarea.focus();
    textarea.setSelectionRange(token.start, token.end);
    const inserted = source.insertText?.(item) ?? "";
    // A trailing space is only added where the text does not already have one;
    // either way the caret lands past that space, where no token can reopen.
    const spaced = /\s/.test(textarea.value.charAt(token.end));
    const text = spaced ? inserted.replace(/\s+$/, "") : inserted;
    const caret = token.start + text.length + (spaced && inserted !== text ? 1 : 0);
    // Native editing command keeps the browser undo transaction where supported.
    const removed =
      typeof document.execCommand === "function" &&
      (text
        ? document.execCommand("insertText", false, text)
        : document.execCommand("delete", false));
    if (!removed) {
      textarea.setRangeText(text, token.start, token.end, "end");
      // setRangeText edits the DOM behind React's back, so its value tracker
      // holds the pre-accept string. Retyping "#" after accepting "#" recreates
      // that string, compares equal, and is swallowed: the character lands in
      // the DOM but onChange never fires. A native input event resyncs the
      // tracker; execCommand dispatches its own.
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    onChange(textarea.value);
    source.onSelect(item.id);
    setDismissed({ signature, value });
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
      syncSelection();
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (
      !open ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive({
        signature,
        index:
          (selectedIndex + (event.key === "ArrowDown" ? 1 : results.length - 1)) % results.length,
      });
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      accept(selectedIndex);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed({ signature, value });
      return true;
    }
    return false;
  };

  return {
    onKeyDown,
    onSelectionChange: syncSelection,
    aria: open
      ? {
          "aria-autocomplete": "list" as const,
          "aria-controls": `${id}-list`,
          "aria-activedescendant": `${id}-${selectedIndex}`,
        }
      : {},
    popup: (
      <Popover
        open={open}
        modal={false}
        onOpenChange={(next) => {
          if (!next) setDismissed({ signature, value });
        }}
      >
        <PopoverContent
          anchor={anchor}
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          // The caret keeps the focus and the caret keeps the typing: opening
          // this list must not move either.
          initialFocus={false}
          finalFocus={false}
          role="presentation"
          className="gap-0 p-1.5"
          onPointerDown={(event) => event.preventDefault()}
        >
          <div id={`${id}-list`} role="listbox" aria-label={source?.label ?? ""}>
            {results.map((item, index) => (
              <div
                key={item.id}
                id={`${id}-${index}`}
                role="option"
                aria-selected={index === selectedIndex}
                onPointerMove={() => setActive({ signature, index })}
                onClick={() => accept(index)}
                className={cn(
                  "cursor-pointer rounded-2xl px-3 py-2",
                  index === selectedIndex && "bg-accent",
                )}
              >
                <p className="truncate text-sm font-medium">
                  {item.label}
                  {item.meta ? (
                    <span className="text-muted-foreground ml-2 text-xs">{item.meta}</span>
                  ) : null}
                </p>
                {item.description ? (
                  <p className="text-muted-foreground truncate text-xs">{item.description}</p>
                ) : null}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    ),
  };
}
