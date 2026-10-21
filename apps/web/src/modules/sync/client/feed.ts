/**
 * The tab's sync connection, opened by the app route before its loaders read.
 * The server sends `sync.ready` once it has subscribed, so data read after that
 * cannot miss a change, and the first open needs no refresh of everything.
 * `useSync` takes the connection over, with the frames it saw before mounting.
 */

/** Past this, loaders go ahead and the first open refreshes instead. */
const READY_WAIT_MS = 1_000;

type Frame = { type: "open" | "error" | "sync"; data: string };

interface Feed {
  source: EventSource;
  backlog: Frame[];
  /** Subscribed before the app's loaders started reading. */
  subscribedBeforeReads: boolean;
  ready: Promise<void>;
  detach: () => void;
}

let feed: Feed | null = null;
let taken = false;

const isReady = (frame: Frame) => {
  if (frame.type !== "sync") return false;
  try {
    return (JSON.parse(frame.data) as { type?: unknown }).type === "sync.ready";
  } catch {
    return false;
  }
};

function open(): Feed {
  const source = new EventSource("/api/sync");
  const backlog: Frame[] = [];
  let settle!: () => void;
  const ready = new Promise<void>((done) => {
    settle = done;
  });
  const record = (type: Frame["type"]) => (event: Event) => {
    const { data } = event as Partial<MessageEvent>;
    const frame = { type, data: typeof data === "string" ? data : "" };
    backlog.push(frame);
    if (isReady(frame) || type === "error") settle();
  };
  const listeners = (["open", "error", "sync"] as const).map(
    (type) => [type, record(type)] as const,
  );
  for (const [type, listener] of listeners) source.addEventListener(type, listener);
  return {
    source,
    backlog,
    subscribedBeforeReads: false,
    ready,
    detach: () => {
      for (const [type, listener] of listeners) source.removeEventListener(type, listener);
    },
  };
}

/**
 * Opens the feed once per document and waits, briefly, until the server has
 * subscribed. Later navigations, and any after `useSync` took it, return at once.
 */
export async function openSyncFeed(): Promise<void> {
  if (taken || typeof EventSource === "undefined") return;
  const current = (feed ??= open());
  const waited = await Promise.race([
    current.ready.then(() => true),
    new Promise<false>((done) => setTimeout(() => done(false), READY_WAIT_MS)),
  ]);
  // Only the wait that let loaders start may vouch for what they read.
  if (waited && current.backlog.some(isReady) && !taken) current.subscribedBeforeReads = true;
}

/** Closes a feed opened for a tree that will not render, such as a sign-in redirect. */
export function closeSyncFeed() {
  feed?.detach();
  feed?.source.close();
  feed = null;
}

/** Hands the connection to its one consumer, or nothing if none was opened. */
export function takeSyncFeed() {
  if (taken || !feed || feed.source.readyState === EventSource.CLOSED) return null;
  taken = true;
  feed.detach();
  const { source, backlog, subscribedBeforeReads } = feed;
  feed = null;
  return { source, backlog, subscribedBeforeReads };
}
