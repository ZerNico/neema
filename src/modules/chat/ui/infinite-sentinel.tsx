import { useEffect, useRef } from "react";
import { Button } from "~/ui/primitives/button";
import { Spinner } from "~/ui/primitives/spinner";

/**
 * Bottom-of-list loader for an infinite query. The button is the real control
 * — scrolling is a convenience, and a keyboard user never triggers it — while
 * an IntersectionObserver fires the same callback once the row comes into
 * view. jsdom and SSR have no observer, so there they just get the button.
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
  // identity — react-query hands back a fresh `fetchNextPage` each render,
  // and re-observing a still-visible sentinel would fire it again.
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
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground w-full"
        onClick={onLoadMore}
        disabled={isFetching}
        aria-busy={isFetching || undefined}
      >
        {isFetching ? <Spinner data-icon="inline-start" aria-hidden /> : null}
        {isFetching ? "Loading more" : "Load more"}
      </Button>
    </div>
  );
}
