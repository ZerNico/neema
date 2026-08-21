import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useRef, useState } from "react";
import { type DisplayMessage, MessageBubble } from "./message-list.tsx";
import { Button } from "~/ui/primitives/button";
import { cn } from "~/ui/utils";

// Virtualized, bottom-anchored message list. Only visible messages render
// (long chats stay cheap), heights are measured dynamically (markdown blocks
// vary wildly), and the list follows streaming output while the user is at
// the bottom. Scrolling up detaches; a jump-to-bottom button reattaches.
export function VirtualMessageList({
  messages,
  /** Monotonically growing signal (e.g. streamed text length) to follow. */
  followKey,
}: {
  messages: DisplayMessage[];
  followKey: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  // Whether auto-follow is engaged; detaches when the user scrolls up.
  const pinnedRef = useRef(true);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 96,
    overscan: 6,
    getItemKey: (index) => messages[index]!.id,
  });

  // When an item above the viewport resizes (e.g. images/code settle),
  // keep the visual position stable instead of jumping. Instance-level
  // property in virtual-core, not a constructor option.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    item.start < (instance.scrollOffset ?? 0);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    pinnedRef.current = true;
    setAtBottom(true);
  }, []);

  // Track whether the user is at (or near) the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const nearBottom = distance < 48;
      setAtBottom(nearBottom);
      pinnedRef.current = nearBottom;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Follow new content while pinned: new messages or streamed text growth.
  // biome/oxlint: followKey is the intentional trigger.
  useEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [messages.length, followKey, scrollToBottom]);

  // Land at the bottom on first mount — and stay there while the virtualizer
  // replaces its initial size estimates with real measured heights. Rows are
  // measured as they render, so the total size keeps growing for a few frames
  // after mount; a single mount-time scroll would end up mid-list.
  const totalSize = virtualizer.getTotalSize();
  useEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [totalSize, scrollToBottom]);

  const items = virtualizer.getVirtualItems();

  return (
    <div className="relative h-full min-h-0">
      {/* stable both-edges keeps centered content aligned with the composer,
          which sits outside this scroll container (no scrollbar offset). */}
      <div ref={scrollRef} className="h-full overflow-y-auto [scrollbar-gutter:stable_both-edges]">
        <div
          className="relative mx-auto w-full max-w-3xl"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {items.map((item) => (
            // Padding lives on the absolute row itself: absolute positioning
            // ignores the container's padding, which previously let messages
            // span wider than the composer and touch the viewport edge.
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className="absolute left-0 top-0 w-full px-4 py-2"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <MessageBubble message={messages[item.index]!} />
            </div>
          ))}
        </div>
      </div>
      <Button
        size="icon-sm"
        variant="outline"
        aria-label="Jump to bottom"
        onClick={() => scrollToBottom("smooth")}
        className={cn(
          "absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-md transition-opacity",
          atBottom ? "pointer-events-none opacity-0" : "opacity-100",
        )}
      >
        <HugeiconsIcon icon={ArrowDown01Icon} className="size-4" />
      </Button>
    </div>
  );
}
