import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { type DisplayMessage, MessageBubble } from "./message-list.tsx";
import { Button } from "~/ui/primitives/button";
import { cn } from "~/ui/utils";

const BOTTOM_THRESHOLD = 48;
const ESTIMATED_MESSAGE_HEIGHT = 96;

// Virtualized, bottom-anchored message list. Only visible messages render
// (long chats stay cheap), heights are measured dynamically (markdown blocks
// vary wildly), and the list follows streaming output while the user is at
// the bottom. Scrolling up detaches; a jump-to-bottom button reattaches.
export function VirtualMessageList({
  messages,
  /** Monotonically growing signal (e.g. streamed text length) to follow. */
  followKey,
  footer,
}: {
  messages: DisplayMessage[];
  followKey: number;
  footer?: ReactNode;
}) {
  "use no memo";

  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  // Whether auto-follow is engaged; detaches when the user scrolls up.
  const pinnedRef = useRef(true);
  const count = messages.length + (footer ? 1 : 0);

  // oxlint-disable-next-line react/incompatible-library -- TanStack Virtual exposes a mutable imperative instance
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_MESSAGE_HEIGHT,
    // Begin with the ending range on the very first render. Without an initial
    // offset, the mount effect first renders and measures the beginning of a
    // long chat, then walks through several expensive markdown slices on its
    // way to the bottom.
    initialOffset: () => count * ESTIMATED_MESSAGE_HEIGHT,
    overscan: 6,
    getItemKey: (index) => messages[index]?.id ?? "message-list-footer",
    anchorTo: "end",
    scrollEndThreshold: BOTTOM_THRESHOLD,
    useAnimationFrameWithResizeObserver: true,
  });

  // When an item above the viewport resizes (e.g. images/code settle),
  // keep the visual position stable instead of jumping. Instance-level
  // property in virtual-core, not a constructor option.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    item.end <= (instance.scrollOffset ?? 0);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      if (!scrollRef.current) return;
      pinnedRef.current = true;
      setAtBottom(true);
      virtualizer.scrollToEnd({ behavior });
    },
    [virtualizer],
  );

  // Track whether the user is at (or near) the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const nearBottom = distance <= BOTTOM_THRESHOLD;
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
  }, [count, followKey, scrollToBottom]);

  const items = virtualizer.getVirtualItems();

  return (
    <div className="relative h-full min-h-0">
      {/* stable both-edges keeps centered content aligned with the composer,
          which sits outside this scroll container (no scrollbar offset).
          The mask fades the last bit of content out right above the composer
          instead of hard-clipping it. */}
      {/* pb-8 lets the last message scroll fully above the fade zone, so
          nothing stays faded when scrolled to the end. */}
      <div
        ref={scrollRef}
        className={cn(
          "h-full overflow-y-auto pb-8 [overflow-anchor:none] [scrollbar-gutter:stable_both-edges]",
          "[mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)]",
        )}
      >
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
              // Offset with `top`, not translateY: a transform makes the row a
              // containing block, and a `position: sticky` descendant then
              // resolves against the row instead of the scrollport — which
              // parked streamdown's code-block toolbar partway down the page.
              className="absolute left-0 w-full px-4 py-2"
              style={{ top: item.start }}
            >
              {item.index < messages.length ? (
                <MessageBubble message={messages[item.index]!} />
              ) : (
                footer
              )}
            </div>
          ))}
        </div>
      </div>
      <Button
        size="icon-sm"
        variant="floating"
        aria-label="Jump to bottom"
        onClick={() => scrollToBottom("smooth")}
        className={cn(
          "absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full transition-opacity",
          atBottom ? "pointer-events-none opacity-0" : "opacity-100",
        )}
      >
        <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
      </Button>
    </div>
  );
}
