import { useEffect, useRef, useState } from "react";

// Providers vary wildly in chunk size: the mock streams ~7-char deltas, an
// aggregator like 9router sends ~90-char ones. Smoothing is purely
// presentational: the reducer's text, lastSeq/resume bookkeeping and
// persisted chunks stay untouched; only what the user sees trails behind,
// released a word at a time.

const TICK_MS = 30;
/** One extra word per tick for every this-many words of backlog. */
const CATCH_UP_DIVISOR = 10;
/** Leading whitespace plus the next word, released as one unit. */
const WORD = /^\s*\S+/;

/**
 * One pacing step: how much of `target` is shown after a tick, given `shown`
 * is visible now. Exported for tests; the hook just applies it on a timer.
 */
export function nextSmoothStep(shown: string, target: string): string {
  // A target that doesn't extend what's shown is a different generation
  // (retry, navigation), so snap instead of animating a rewrite.
  if (!target.startsWith(shown)) return target;
  let pending = target.slice(shown.length);
  if (!pending) return shown;

  // Pace by words, but bound the lag: a provider outrunning the base rate (or
  // a resume burst) releases proportionally more per tick instead of letting
  // the display drift ever further behind the stream.
  const backlog = pending.split(/\s+/).filter(Boolean).length;
  let release = Math.max(1, Math.round(backlog / CATCH_UP_DIVISOR));

  let out = shown;
  while (release > 0) {
    const word = WORD.exec(pending);
    if (!word) {
      // Only whitespace left; holding it back would just delay the next word.
      return out + pending;
    }
    out += word[0];
    pending = pending.slice(word[0].length);
    release -= 1;
  }
  return out;
}

/**
 * The visible, word-paced view of a growing stream. The returned string
 * trails `target` and catches up one tick at a time, and keeps pacing after
 * the stream ends, so the provider's last chunk lands as words like every
 * other one, never as a final pop. History never animates (the first value
 * is shown as-is), and a target that rewrites what is shown (retry,
 * navigation) snaps instead of animating.
 */
export function useSmoothText(target: string): string {
  const targetRef = useRef(target);
  const [shown, setShown] = useState(target);

  // Written from an effect, not render: the interval below reads it, and a
  // one-tick-stale target only delays a word by TICK_MS.
  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  // Adjust-during-render (guarded, so it cannot loop): a new generation must
  // never flash the previous one's tail while waiting for the first tick.
  if (!target.startsWith(shown)) {
    setShown(target);
  }

  // The pacer exists only while the display lags; catching up tears it down,
  // the next growth spurt recreates it.
  const lagging = shown !== target && target.startsWith(shown);
  useEffect(() => {
    if (!lagging) return;
    const timer = setInterval(() => {
      setShown((prev) => nextSmoothStep(prev, targetRef.current));
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [lagging]);

  return target.startsWith(shown) ? shown : target;
}
