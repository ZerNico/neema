import { m } from "~/paraglide/messages.js";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useRef, useState } from "react";
import { estimateMessageHeight } from "./estimate-message-height.ts";
import { type DisplayMessage, MessageBubble } from "./message-list.tsx";
import { Button } from "~/ui/primitives/button";
import { Spinner } from "~/ui/primitives/spinner";
import { cn } from "~/ui/utils";

const BOTTOM_THRESHOLD = 48;
/** The column's `max-w-3xl`, the width rows have before the list is laid out. */
const COLUMN_WIDTH = 768;
/** Estimates per message object, redone only when the column width changes. */
const estimates = new WeakMap<DisplayMessage, { width: number; height: number }>();
/** How close to the first loaded row (overscan included) older turns start loading. */
const REACH_START_ROWS = 3;
/** Where an anchored question sits below the top of the view. */
const ANCHOR_OFFSET = 16;
/** The scroller's `pb-8`, part of what the view scrolls through below the last row. */
const BOTTOM_PADDING = 32;

/**
 * The empty space an anchored question needs below the last row to scroll to
 * the top of the view, from the last measured rows. Zero once its answer
 * fills the view, or when the question is not among the rendered rows, which
 * it always is while the space matters.
 */
function anchoredEndSpace(
  virtualizer: Virtualizer<HTMLDivElement, Element> | null,
  anchorIndex: number,
  count: number,
  viewport: number,
) {
  const items = virtualizer?.getVirtualItems() ?? [];
  const anchor = items.find((item) => item.index === anchorIndex);
  const last = items.at(-1);
  if (!anchor || last?.index !== count - 1) return 0;
  return Math.max(0, viewport - BOTTOM_PADDING - ANCHOR_OFFSET - (last.end - anchor.start));
}

/**
 * Virtualized, bottom-anchored message list. Only visible messages render
 * (long chats stay cheap), heights are measured dynamically (markdown blocks
 * vary wildly), and the list follows streaming output while the user is at
 * the bottom. Scrolling up detaches; a jump-to-bottom button reattaches.
 *
 * Following is the virtualizer's own: with `anchorTo: "end"` a row growing
 * while the view sits at the end keeps it there, and `followOnAppend` does the
 * same for new rows. Nothing here reacts to streamed text, so the live row can
 * re-render without this list doing so.
 *
 * An anchored question (the one the reader just asked) instead sits at the top
 * of the view with empty space below it for the answer, and nothing follows
 * the stream until the reader jumps to the bottom.
 */
export function VirtualMessageList({
  messages,
  onReachStart,
  loadingOlder = false,
  anchorId = null,
  onReleaseAnchor,
}: {
  messages: DisplayMessage[];
  /** Called while the rows near the top are on screen, to load older turns. */
  onReachStart?: () => void;
  loadingOlder?: boolean;
  /** The question to hold at the top of the view while its answer arrives. */
  anchorId?: string | null;
  onReleaseAnchor?: () => void;
}) {
  "use no memo";

  const scrollRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const count = messages.length;
  const instance = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  const anchorIndex = anchorId ? messages.findIndex((message) => message.id === anchorId) : -1;
  const anchored = anchorIndex >= 0;
  // From the previous render's measurements: every measurement re-renders the
  // list, so the space shrinks as the answer grows and nothing on screen moves.
  const endSpace = anchored
    ? anchoredEndSpace(instance.current, anchorIndex, count, scrollRef.current?.clientHeight ?? 0)
    : 0;

  // Close guesses keep rows from resizing as they mount: every miss above the
  // viewport is offset by moving the scroll position under the reader.
  const estimate = (index: number) => {
    const message = messages[index]!;
    const width = columnRef.current?.clientWidth || COLUMN_WIDTH;
    const known = estimates.get(message);
    if (known?.width === width) return known.height;
    const height = estimateMessageHeight(message, width);
    estimates.set(message, { width, height });
    return height;
  };

  // oxlint-disable-next-line react/incompatible-library -- TanStack Virtual exposes a mutable imperative instance
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimate,
    // Begin with the ending range on the very first render. Without an initial
    // offset, the mount effect first renders and measures the beginning of a
    // long chat, then walks through several expensive markdown slices on its
    // way to the bottom.
    initialOffset: () => messages.reduce((sum, _, index) => sum + estimate(index), 0),
    overscan: 6,
    getItemKey: (index) => messages[index]!.id,
    anchorTo: "end",
    paddingEnd: endSpace,
    // An anchored turn is read from the top: no following new rows, and a
    // negative threshold keeps growth from ever counting as "at the end".
    followOnAppend: !anchored,
    scrollEndThreshold: anchored ? -1 : BOTTOM_THRESHOLD,
    // Measure inside the ResizeObserver callback, which runs before paint, so
    // the scroll correction lands in the frame the row grew. Deferring it to
    // the next frame painted a streamed code block below the fold first.
    useAnimationFrameWithResizeObserver: false,
  });

  instance.current = virtualizer;

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      if (!scrollRef.current) return;
      setAtBottom(true);
      virtualizer.scrollToEnd({ behavior });
    },
    [virtualizer],
  );

  // Bring a newly anchored question to the top once the space below it is in
  // place; before that, the scroll would stop short at the end.
  const positioned = useRef<string | null>(null);
  const anchorStart = virtualizer
    .getVirtualItems()
    .find((item) => item.index === anchorIndex)?.start;
  useEffect(() => {
    const el = scrollRef.current;
    if (!anchorId || anchorStart === undefined || positioned.current === anchorId || !el) return;
    const target = Math.max(0, anchorStart - ANCHOR_OFFSET);
    if (target > virtualizer.getTotalSize() + BOTTOM_PADDING - el.clientHeight + 1) return;
    positioned.current = anchorId;
    // A chat too short to scroll leaves virtual-core holding "keep the end in
    // view" corrections it could not apply; no scroll event clears them, and
    // it replays one once the answer grows, pulling the question away. There
    // is no public way to drop it.
    Reflect.set(virtualizer, "_clampedAdjustment", null);
    virtualizer.scrollToOffset(target, { behavior: "smooth" });
  }, [anchorId, anchorStart, endSpace, virtualizer]);

  // Whether anything is hidden below, for the jump button. Also checked when
  // the list grows, since an anchored answer passes the bottom edge without a
  // scroll. While that answer still fits its space nothing is hidden, even
  // mid-glide to the question, when the space itself is below the view.
  const endSpaceRef = useRef(endSpace);
  endSpaceRef.current = endSpace;
  const updateAtBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return false;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD;
    setAtBottom(atEnd || endSpaceRef.current > 0);
    return atEnd;
  }, []);
  // Scrolling down to the end of an answer that has outgrown its space is
  // asking to follow it, like the jump button. Only a scroll counts: the
  // answer growing past the bottom must leave the question where it is.
  const anchoredRef = useRef(anchored);
  anchoredRef.current = anchored;
  const releaseRef = useRef(onReleaseAnchor);
  releaseRef.current = onReleaseAnchor;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (updateAtBottom() && anchoredRef.current && endSpaceRef.current === 0)
        releaseRef.current?.();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [updateAtBottom]);
  const totalSize = virtualizer.getTotalSize();
  useEffect(() => {
    updateAtBottom();
  }, [updateAtBottom, totalSize, endSpace]);

  // Settle on the end once the first rows are measured; from here on the
  // virtualizer keeps it there. A chat that opens on an anchored question
  // (just started from the new-chat page) positions that instead.
  const opensAnchored = useRef(anchored);
  useEffect(() => {
    if (!opensAnchored.current) scrollToBottom();
  }, [scrollToBottom]);

  const items = virtualizer.getVirtualItems();

  // Rows added above keep the reader's place: with stable keys, `anchorTo:
  // "end"` holds the row on screen still when the ones before it change.
  const firstIndex = items[0]?.index;
  useEffect(() => {
    if (firstIndex !== undefined && firstIndex <= REACH_START_ROWS) onReachStart?.();
  }, [firstIndex, onReachStart]);

  return (
    // Web links clicked in the conversation open as panel tabs on desktop
    // (`browser/ui/browser-host.tsx`).
    <div className="relative h-full min-h-0" data-web-links="panel">
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
          ref={columnRef}
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
              // resolves against the row instead of the scrollport, which
              // parked streamdown's code-block toolbar partway down the page.
              className="absolute left-0 w-full px-4 py-2"
              style={{ top: item.start }}
            >
              <MessageBubble message={messages[item.index]!} />
            </div>
          ))}
        </div>
      </div>
      {loadingOlder ? (
        <div
          role="status"
          className="bg-popover text-muted-foreground absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full px-3 py-1.5 text-xs shadow-sm"
        >
          <Spinner aria-hidden className="size-3.5" />
          {m.chat_list_loading_earlier()}
        </div>
      ) : null}
      <Button
        size="icon-sm"
        variant="floating"
        aria-label={m.chat_list_jump_to_bottom()}
        inert={atBottom || undefined}
        onClick={() => {
          onReleaseAnchor?.();
          scrollToBottom("smooth");
        }}
        className={cn(
          "absolute bottom-3 left-1/2 -translate-x-1/2 transition-opacity",
          atBottom ? "pointer-events-none opacity-0" : "opacity-100",
        )}
      >
        <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
      </Button>
    </div>
  );
}
