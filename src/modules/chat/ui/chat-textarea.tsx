import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { cn } from "~/ui/utils";

export const CHAT_INPUT_SHELL_CLASS = cn(
  "border-border bg-background w-full rounded-[1.375rem] border shadow-sm transition-shadow",
  "focus-within:border-ring/40 focus-within:shadow-md",
);

export const ChatTextarea = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onValueChange: (value: string) => void;
    onSubmit: () => void;
    onCancel?: (() => void) | undefined;
    placeholder?: string;
    autoFocus?: boolean;
    disabled?: boolean;
    className?: string;
  }
>(function ChatTextarea(
  {
    value,
    onValueChange,
    onSubmit,
    onCancel,
    placeholder,
    autoFocus = false,
    disabled = false,
    className,
  },
  forwardedRef,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(forwardedRef, () => textareaRef.current!);

  // The controlled value is the resize trigger, not a value read by the effect.
  // oxlint-disable react/exhaustive-effect-dependencies
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value]);
  // oxlint-enable react/exhaustive-effect-dependencies

  return (
    <textarea
      ref={textareaRef}
      rows={1}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
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
      autoFocus={autoFocus}
      disabled={disabled}
      className={cn(
        "placeholder:text-muted-foreground block max-h-52 w-full resize-none overflow-y-auto",
        "bg-transparent px-4 pb-1 pt-3.5 text-sm leading-6 outline-none disabled:opacity-60",
        className,
      )}
    />
  );
});
