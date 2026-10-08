// The Streamdown renderer for ```ui fences. Loaded lazily, so the parser,
// QuickJS client and components stay out of the chat bundle until an answer
// has a block. Every failure falls back to the block's source.

import {
  Component,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import * as m from "motion/react-m";
import { toast } from "sonner";
import type { CustomRendererProps } from "streamdown";
import { motionEase } from "~/ui/motion-presets.ts";
import { useAppReducedMotion } from "~/ui/reduced-motion.ts";
import { LeaveDialog } from "~/ui/leave-dialog.tsx";
import type { RenderReply } from "../client/engine.ts";
import { sharedWorkerClient, type GenuiClient, type Unavailable } from "../client/host.ts";
import { recall, recallState, remember } from "../client/memory.ts";
import { cachedTree, keepTree, warmTrees, type DrawnTree } from "../client/tree-cache.ts";
import { fenceKey, hashSource } from "../fences.ts";
import type { BlockAction } from "../runtime.ts";
import { copiedPreview, hasHiddenText, mentionsUrl } from "../text.ts";
import {
  DispatchContext,
  GenuiActionsContext,
  GenuiClientContext,
  GenuiMessageContext,
  SuggestContext,
  type Dispatch,
  type GenuiMessage,
  type TrustedEvent,
} from "./context.ts";
import { BlockSkeleton } from "./frame.tsx";
import { Nodes } from "./tree.tsx";

/** While a block is still being written, it re-renders at most this often. */
const STREAMING_RENDER_MS = 250;

function Source({ code }: { code: string }) {
  return (
    <pre className="bg-muted overflow-x-auto rounded-2xl p-3 font-mono text-xs">
      <code>{code}</code>
    </pre>
  );
}

const noop = () => () => {};

/**
 * Shows a block's source when its tree throws while rendering, such as a
 * cached tree an older build drew. It costs that block, never the chat, and
 * a new source tries again.
 */
class BlockBoundary extends Component<
  { code: string; children: ReactNode },
  { failed: boolean; code: string }
> {
  state = { failed: false, code: this.props.code };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: { code: string },
    state: { failed: boolean; code: string },
  ) {
    return props.code === state.code ? null : { failed: false, code: props.code };
  }

  render() {
    return this.state.failed ? <Source code={this.props.code} /> : this.props.children;
  }
}

/** Text a block may send or copy; anything longer is cut off as a mistake. */
const SEND_CHARS = 500;
/**
 * The longest suggestion sent with one click. A longer one goes to the
 * composer, where the reader sees all of it before it is sent.
 */
const SUGGEST_CHARS = 120;
const COPY_CHARS = 4096;
/** Saves wait for the reader to settle, so a dragged slider writes once. */
const SAVE_DELAY_MS = 1000;

interface BlockProps {
  client: GenuiClient;
  block: string;
  ordinal: number;
  code: string;
  streaming: boolean;
  now: number;
  /** State to start from when this session has none: the stored row for this source. */
  persisted: string | null;
  /** Keep the drawn tree in the device cache; never for a temporary chat. */
  keep: boolean;
  onActions: (actions: readonly BlockAction[], trusted: TrustedEvent) => void;
  onState: (state: string) => void;
}

/**
 * A tree and its state without revisions. Two renders that compare equal show
 * the same thing from the same state, so the same handler index does the same
 * thing: two branches that merely look alike differ in state.
 */
const shapeOf = (tree: DrawnTree) =>
  `${tree.state ?? ""}|${JSON.stringify(tree.nodes, (key, value) => (key === "rev" ? 0 : value))}`;

/**
 * A click on a tree that is not live yet, by block, replayed once it is.
 * Outside React: the block often remounts (Streamdown, the virtual list)
 * between the click and its live render, and the click must not go with it.
 */
const queuedClicks = new Map<string, Queued>();

interface Queued {
  readonly handler: number;
  readonly args: readonly unknown[];
  readonly trusted: TrustedEvent;
  /** The tree the reader clicked in. */
  readonly shape: string;
  /** The Worker it was meant for, and when: a click outlives a remount, not a visit. */
  readonly client: GenuiClient;
  readonly at: number;
}

/** Long enough for a remount and the first live render, short of a return visit. */
const QUEUED_CLICK_MS = 2000;

function useBlock({
  client,
  block,
  code,
  streaming,
  now,
  persisted,
  keep,
  onActions,
  onState,
}: BlockProps) {
  // What the reader saw last, from this session's memory or the device's
  // cache, so a remount or reload shows the block at once. It is not live:
  // its handlers belong to a runtime that is gone until the Worker redraws it.
  const [reply, setReply] = useState<RenderReply | Unavailable | null>(
    () =>
      recall(block, code)?.reply ??
      (streaming || !keep ? undefined : cachedTree(block, code)) ??
      null,
  );
  const [live, setLive] = useState(false);
  // Replies are stamped with the Worker generation that produced them: a
  // restart makes every handler reference in the shown tree stale.
  const [stamp, setStamp] = useState(client.epoch());
  const epoch = useSyncExternalStore(client.subscribe, client.epoch, () => 0);
  const lastRender = useRef(0);
  const run = useRef<(tree: DrawnTree, handler: number, q: Queued, at: number) => Promise<void>>(
    async () => {},
  );
  // The source being shown now, which a late reply to an older call must not undo.
  const current = useRef(code);
  useEffect(() => {
    current.current = code;
  });
  const startFrom = useCallback(
    () => recallState(block, code) ?? persisted,
    [block, code, persisted],
  );

  // The device cache may still have been loading when this mounted.
  useEffect(() => {
    if (streaming || !keep) return;
    let cancelled = false;
    void warmTrees().then(() => {
      const tree = cachedTree(block, code);
      if (!cancelled && tree) setReply((shown) => shown ?? tree);
    });
    return () => {
      cancelled = true;
    };
  }, [block, code, streaming, keep]);

  const show = useCallback(
    (next: RenderReply | Unavailable, at: number, source: string) => {
      if (next.ok || next.reason !== "unavailable") remember(block, source, next);
      if (next.ok && !streaming && keep) keepTree(block, source, next);
      setReply(next);
      setStamp(at);
      setLive(true);
      const click = queuedClicks.get(block);
      queuedClicks.delete(block);
      // Only into the same tree: anything else would run a handler the reader never saw.
      if (
        click &&
        next.ok &&
        click.client === client &&
        Date.now() - click.at < QUEUED_CLICK_MS &&
        shapeOf(next) === click.shape
      ) {
        void run.current(next, click.handler, click, at);
      }
    },
    [block, client, streaming, keep],
  );

  useEffect(() => {
    let cancelled = false;
    const render = () => {
      lastRender.current = Date.now();
      const at = client.epoch();
      void client.render({ block, code, saved: startFrom(), now }).then((next) => {
        if (!cancelled) show(next, at, code);
      });
    };
    const wait = streaming ? Math.max(0, lastRender.current + STREAMING_RENDER_MS - Date.now()) : 0;
    const timer = setTimeout(render, wait);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- epoch re-renders the block in a restarted Worker
  }, [client, block, code, streaming, now, epoch, show, startFrom]);

  useEffect(() => () => client.release(block), [client, block]);

  useEffect(() => {
    run.current = async (tree, handler, click, at) => {
      const result = await client.call({
        block,
        source: tree.source,
        rev: tree.rev,
        handler,
        args: click.args,
      });
      if (result.ok) {
        show(result.render, at, code);
        if (result.render.ok && result.render.state !== null) onState(result.render.state);
        onActions(result.actions, click.trusted);
      } else if ("stale" in result && result.stale && current.current === code) {
        // Redrawn only while this source is still the one shown; a newer one renders itself.
        show(await client.render({ block, code, saved: startFrom(), now }), at, code);
      }
    };
  });

  const dispatch: Dispatch = useCallback(
    async (ref, args, trusted) => {
      if (!reply?.ok) return;
      const click = {
        handler: ref.$h,
        args,
        trusted,
        shape: shapeOf(reply),
        client,
        at: Date.now(),
      };
      if (!live) {
        queuedClicks.set(block, click);
        return;
      }
      if (stamp !== client.epoch() || ref.rev !== reply.rev) return;
      // Awaited, so a control waits for this reply before sending its next value.
      await run.current(reply, ref.$h, click, client.epoch());
    },
    [block, client, live, reply, stamp],
  );

  return { reply, dispatch };
}

function Block(props: BlockProps & { suggest: ((text: string) => void) | null }) {
  const { reply, dispatch } = useBlock(props);
  const { block, code, streaming, suggest } = props;
  const reduced = useAppReducedMotion();
  // Fade in only what replaces a skeleton: a block the virtual list remounts
  // from memory is already on screen in the reader's mind.
  const [startedEmpty] = useState(reply === null);
  if (reply === null || (!reply.ok && reply.reason === "incomplete")) {
    return <BlockSkeleton />;
  }
  if (!reply.ok) {
    // Still being written, a failure is most likely a half-sent expression.
    if (streaming) return <BlockSkeleton />;
    return <Source code={code} />;
  }
  return (
    <m.div
      className="flex flex-col gap-3"
      data-genui-block={block}
      // Not from nothing: the first frame of the grow already shows the block.
      initial={startedEmpty && !reduced ? { opacity: 0.3 } : false}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: motionEase }}
    >
      <DispatchContext value={dispatch}>
        <SuggestContext value={suggest}>
          <Nodes nodes={reply.nodes} />
        </SuggestContext>
      </DispatchContext>
    </m.div>
  );
}

/**
 * State a reader set that is not saved yet, by block. Outside React because
 * Streamdown remounts a block when its answer finishes, exactly when a change
 * made while it streamed first becomes savable.
 */
const unsaved = new Map<string, string>();

/**
 * Saves what the reader set, once they settle. A change made while the answer
 * still streams waits for it to finish, since only a finished answer stores
 * state, and a save still waiting when the block unmounts (scrolled away, chat
 * switched) is sent then rather than dropped.
 */
function useBlockSave(message: GenuiMessage, block: string, ordinal: number, code: string) {
  const actions = use(GenuiActionsContext);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useRef(() => {});
  const { messageId, streaming } = message;
  // A branch's copy has no attempt (null) yet still saves; undefined means unknown.
  const generationId = message.generationId;
  const canSave = actions !== null && !streaming && generationId !== undefined;

  useEffect(() => {
    flush.current = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const state = unsaved.get(block);
      if (state === undefined || !canSave) return;
      unsaved.delete(block);
      actions.save({ messageId, generationId, ordinal, sourceHash: hashSource(code), state });
    };
  });

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => flush.current(), SAVE_DELAY_MS);
  }, []);

  // Mounted, or the answer finished, with a change still unsaved.
  useEffect(() => {
    if (canSave && unsaved.has(block)) schedule();
  }, [canSave, block, schedule]);

  useEffect(() => () => flush.current(), []);

  return useCallback(
    (state: string) => {
      unsaved.set(block, state);
      if (canSave) schedule();
    },
    [block, canSave, schedule],
  );
}

/**
 * What a block's actions may do, decided here and not in the block: which
 * event fired, on which element, and what the text says. A prompt-injected
 * block can draw a misleading button; it cannot send on the reader's behalf.
 */
function useBlockActions(message: GenuiMessage, block: string, ordinal: number, code: string) {
  const actions = use(GenuiActionsContext);
  const [leaving, setLeaving] = useState<string | null>(null);
  const canSend =
    actions !== null &&
    !actions.disabled &&
    !message.streaming &&
    actions.tailId === message.messageId;

  const onActions = useCallback(
    (queued: readonly BlockAction[], trusted: TrustedEvent) => {
      const clicked = trusted.event === "click" && trusted.tag === "button";
      for (const action of queued) {
        if (hasHiddenText(action.value)) continue;
        if (action.kind === "send" && clicked && canSend && action.value.trim()) {
          // A handler's text was never shown as its label, so the reader sends it.
          actions?.offer(action.value.slice(0, SEND_CHARS));
        } else if (action.kind === "open" && clicked && /^https?:\/\//i.test(action.value)) {
          setLeaving(action.value);
        } else if (action.kind === "copy" && clicked && action.value.length <= COPY_CHARS) {
          void navigator.clipboard?.writeText(action.value).then(() => {
            toast.success("Copied", { description: copiedPreview(action.value) });
          });
        }
      }
    },
    [actions, canSend],
  );

  const onState = useBlockSave(message, block, ordinal, code);

  const suggest = useMemo(() => {
    if (!canSend || !actions) return null;
    return (text: string) => {
      // As the chip shows it: runs of whitespace collapse to one space.
      const label = text.replace(/\s+/g, " ").trim();
      if (!label || hasHiddenText(label)) return;
      // The label is the message: short, shown in full and without a link, it may go as is.
      if (label.length > SUGGEST_CHARS || mentionsUrl(label))
        actions.offer(label.slice(0, SEND_CHARS));
      else actions.send(label);
    };
  }, [actions, canSend]);

  const dialog = leaving ? (
    <LeaveDialog
      isOpen
      url={leaving}
      onClose={() => setLeaving(null)}
      onConfirm={() => {
        window.open(leaving, "_blank", "noopener,noreferrer");
        setLeaving(null);
      }}
    />
  ) : null;
  return { onActions, onState, suggest, dialog };
}

export default function UiBlock({ code, isIncomplete, meta }: CustomRendererProps) {
  const message = use(GenuiMessageContext);
  const injected = use(GenuiClientContext);
  const key = fenceKey(meta);
  const hydrated = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  // An unkeyed fence (nested in a list, past the block limit, or outside an
  // answer) renders as code: without a key there is nowhere to keep its state.
  if (key === null || message === null) return <Source code={code} />;
  if (!hydrated && !injected) return <BlockSkeleton />;
  return (
    <KeyedBlock
      client={injected ?? sharedWorkerClient()}
      message={message}
      ordinal={key}
      code={code}
      incomplete={isIncomplete}
    />
  );
}

function KeyedBlock({
  client,
  message,
  ordinal,
  code,
  incomplete,
}: {
  client: GenuiClient;
  message: GenuiMessage;
  ordinal: number;
  code: string;
  incomplete: boolean;
}) {
  // One attempt's block: a retry or edit starts its own, from its own
  // initial state, rather than inheriting what the reader set on the last.
  // A resume reopens from the saved row, which only a finished answer has.
  const block = `${message.messageId}:${message.generationId ?? "copy"}:${ordinal}`;
  const { onActions, onState, suggest, dialog } = useBlockActions(message, block, ordinal, code);
  const stored = message.saved?.get(ordinal);
  const persisted = stored && stored.sourceHash === hashSource(code) ? stored.state : null;
  return (
    <>
      {/* A tree this build cannot render costs its block, shown as source, not the chat. */}
      <BlockBoundary code={code}>
        <Block
          client={client}
          block={block}
          ordinal={ordinal}
          code={code}
          streaming={incomplete || message.streaming}
          now={message.createdAt}
          persisted={persisted}
          keep={message.temporary !== true}
          onActions={onActions}
          onState={onState}
          suggest={suggest}
        />
      </BlockBoundary>
      {dialog}
    </>
  );
}
