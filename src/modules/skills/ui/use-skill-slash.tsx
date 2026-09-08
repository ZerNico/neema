import { Popover, PopoverContent } from "~/ui/primitives/popover";
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
import { cn } from "~/ui/utils.ts";
import type { SkillSummary } from "../schema.ts";
import { matchSkillSlash } from "./slash-token.ts";

export interface TextareaSkills {
  items: readonly SkillSummary[];
  onSelect: (id: string) => void;
}
export function useSkillSlash(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  onChange: (value: string) => void,
  skills?: TextareaSkills,
) {
  const id = useId();
  const [selection, setSelection] = useState({ start: 0, end: 0, focused: false });
  const [dismissed, setDismissed] = useState<string | null>(null);
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
  const token =
    skills && selection.focused ? matchSkillSlash(value, selection.start, selection.end) : null;
  const signature = token ? `${token.start}:${token.end}:${token.query}` : null;
  const results = token
    ? skills!.items
        .filter((skill) =>
          `${skill.name} ${skill.description}`.toLowerCase().includes(token.query.toLowerCase()),
        )
        .slice(0, 8)
    : [];
  const open = !!token && signature !== dismissed && results.length > 0;
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
    if (!textarea || !skills) return;
    document.addEventListener("selectionchange", syncSelection);
    for (const event of ["focus", "blur", "select"])
      textarea.addEventListener(event, syncSelection);
    return () => {
      document.removeEventListener("selectionchange", syncSelection);
      for (const event of ["focus", "blur", "select"])
        textarea.removeEventListener(event, syncSelection);
    };
    // oxlint-disable-next-line exhaustive-deps -- syncSelection only reads refs and setState
  }, [ref, skills]);
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
    if (!textarea || !token || !item) return;
    textarea.focus();
    textarea.setSelectionRange(token.start, token.end);
    // Native editing command keeps the browser undo transaction where supported.
    const removed =
      typeof document.execCommand === "function" && document.execCommand("delete", false);
    if (!removed) textarea.setRangeText("", token.start, token.end, "end");
    onChange(textarea.value);
    skills!.onSelect(item.id);
    setDismissed(signature);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(token.start, token.start);
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
      setDismissed(signature);
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
          if (!next) setDismissed(signature);
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
          <div id={`${id}-list`} role="listbox" aria-label="Local skills">
            {results.map((skill, index) => (
              <div
                key={skill.id}
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
                  {skill.name}
                  {skill.ownerName ? (
                    <span className="text-muted-foreground ml-2 text-xs">{skill.ownerName}</span>
                  ) : null}
                </p>
                <p className="text-muted-foreground truncate text-xs">{skill.description}</p>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    ),
  };
}
