import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { cn } from "~/ui/utils";
import { useTextareaMentions, type MentionItem } from "~/ui/textarea-mention.tsx";

export const CHAT_INPUT_SHELL_CLASS = cn(
  "border-border bg-background w-full rounded-composer border shadow-sm transition-shadow",
  "focus-within:border-ring/40 focus-within:shadow-md",
);

/** Offerable rows plus what to do with the one that is picked. */
export interface TextareaMentions {
  items: readonly MentionItem[];
  onSelect: (id: string) => void;
}

export const ChatTextarea = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onValueChange: (value: string) => void;
    onSubmit: () => void;
    onCancel?: (() => void) | undefined;
    placeholder?: string;
    ariaLabel?: string;
    autoFocus?: boolean;
    disabled?: boolean;
    className?: string;
    /** Typed as `/name`. */
    skills?: TextareaMentions | undefined;
    /** Typed as `#name`. */
    collections?: TextareaMentions | undefined;
  }
>(function ChatTextarea(
  {
    value,
    onValueChange,
    onSubmit,
    onCancel,
    placeholder,
    ariaLabel,
    autoFocus = false,
    disabled = false,
    className,
    skills,
    collections,
  },
  forwardedRef,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(forwardedRef, () => textareaRef.current!);
  // Rebuilt each render on purpose: the hook only reads this during render, and
  // memoising it would imply a stability the inline props do not have anyway.
  const mentions = useTextareaMentions(textareaRef, value, onValueChange, [
    ...(skills ? [{ trigger: "/", label: "Local skills", ...skills }] : []),
    ...(collections ? [{ trigger: "#", label: "Knowledge collections", ...collections }] : []),
  ]);

  // The controlled value is the resize trigger, not a value read by the effect.
  // Layout effect: the textarea must reach its grown height before ancestors
  // measure it pre-paint (the edit-swap height tween in message-list.tsx).
  // oxlint-disable react/exhaustive-effect-dependencies
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value]);
  // oxlint-enable react/exhaustive-effect-dependencies

  return (
    <>
      <textarea
        ref={textareaRef}
        rows={1}
        value={value}
        {...mentions.aria}
        onSelect={mentions.onSelectionChange}
        onChange={(event) => {
          onValueChange(event.target.value);
          mentions.onSelectionChange();
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (mentions.onKeyDown(event)) return;
          if (event.key === "Escape" && onCancel) {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        disabled={disabled}
        className={cn(
          "placeholder:text-muted-foreground block max-h-52 w-full resize-none overflow-y-auto",
          "bg-transparent px-4 pb-1 pt-3.5 text-sm leading-6 outline-none disabled:opacity-60",
          className,
        )}
      />
      {mentions.popup}
    </>
  );
});
