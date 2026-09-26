// Providers vary wildly in chunk size: the mock streams ~7-char deltas, an
// aggregator like 9router sends ~90-char ones. Smoothing is purely
// presentational: the received text, lastSeq/resume bookkeeping and
// persisted chunks stay untouched; only what the user sees trails behind,
// released a word at a time.

const TICK_MS = 30;
/** One extra word per tick for every this-many words of backlog. */
const CATCH_UP_DIVISOR = 10;
/** Leading whitespace plus the next word, released as one unit. */
const WORD = /^\s*\S+/;

/**
 * One pacing step: how much of `target` is shown after a tick, given `shown`
 * is visible now. Exported for tests; the store just applies it on a timer.
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

export interface LiveTextSnapshot {
  /** Word-paced answer text: what the row draws. */
  text: string;
  reasoning: string;
  /** Receipt length before smoothing; activity anchors remain in this coordinate space. */
  rawTextLength: number;
  /** A reasoning phase happened, even one whose content is hidden. */
  reasoningSeen: boolean;
  /** Every received word is on screen. */
  drained: boolean;
}

export interface LiveText {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => LiveTextSnapshot;
  /**
   * Claims a chunk's sequence number. Every chunk kind shares one sequence, so
   * this is the generation's receipt cursor; a replayed or stale chunk is refused.
   */
  claim: (seq: number) => boolean;
  /** The highest sequence claimed so far; resume depends on it being exact. */
  readonly lastSeq: number;
  append: (kind: "text" | "reasoning", delta: string) => void;
}

/**
 * The received text of one generation and its paced view. It lives outside
 * React so a tick notifies only the row drawing it: re-rendering the whole
 * chat 33 times a second made streaming cost grow with the conversation.
 * History never animates (the initial text is shown as-is), and the tail keeps
 * pacing after the stream ends, so the last chunk lands as words, not a pop.
 */
export function createLiveText(initial: {
  text: string;
  reasoning: string;
  reasoningSeen: boolean;
  lastSeq: number;
}): LiveText {
  let text = initial.text;
  let reasoning = initial.reasoning;
  let lastSeq = initial.lastSeq;
  let snapshot: LiveTextSnapshot = {
    text,
    reasoning,
    rawTextLength: text.length,
    reasoningSeen: initial.reasoningSeen,
    drained: true,
  };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const publish = (next: LiveTextSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const stop = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };
  const tick = () => {
    const shownText = nextSmoothStep(snapshot.text, text);
    const shownReasoning = nextSmoothStep(snapshot.reasoning, reasoning);
    const drained = shownText === text && shownReasoning === reasoning;
    publish({
      ...snapshot,
      text: shownText,
      reasoning: shownReasoning,
      rawTextLength: text.length,
      drained,
    });
    if (drained) stop();
  };
  // The pacer runs only while the display lags and someone is watching.
  const start = () => {
    if (timer === null && !snapshot.drained && listeners.size > 0)
      timer = setInterval(tick, TICK_MS);
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: () => snapshot,
    claim(seq) {
      if (seq <= lastSeq) return false;
      lastSeq = seq;
      return true;
    },
    get lastSeq() {
      return lastSeq;
    },
    append(kind, delta) {
      if (kind === "text") text += delta;
      else reasoning += delta;
      const reasoningSeen = snapshot.reasoningSeen || kind === "reasoning";
      const drained = snapshot.text === text && snapshot.reasoning === reasoning;
      // Growth alone waits for the next tick; only a change a subscriber
      // branches on is published straight away.
      if (reasoningSeen !== snapshot.reasoningSeen || drained !== snapshot.drained)
        publish({ ...snapshot, reasoningSeen, drained });
      start();
    },
  };
}
