import { useEffect, useRef } from "react";
import { PendingButton } from "~/ui/pending-button.tsx";

/**
 * Bottom-of-list loader for an infinite query. The button is the real
 * control, since scrolling is a convenience a keyboard user never triggers,
 * while an IntersectionObserver fires the same callback once the row comes
 * into view. jsdom and SSR have no observer, so there they just get the
 * button.
 */
export function InfiniteSentinel({
  hasNext,
  isFetching,
  onLoadMore,
  className,
}: {
  hasNext: boolean;
  isFetching: boolean;
  onLoadMore: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Kept in a ref so re-arming the observer isn't tied to the callback's
  // identity, because react-query hands back a fresh `fetchNextPage` each
  // render, and re-observing a still-visible sentinel would fire it again.
  const load = useRef(onLoadMore);
  useEffect(() => {
    load.current = onLoadMore;
  });

  useEffect(() => {
    const node = ref.current;
    if (!node || !hasNext || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) load.current();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNext]);

  if (!hasNext) return null;

  return (
    <div ref={ref} className={className}>
      <PendingButton
        variant="ghost"
        size="sm"
        className="text-muted-foreground w-full"
        onClick={onLoadMore}
        pending={isFetching}
      >
        Load more
      </PendingButton>
    </div>
  );
}
