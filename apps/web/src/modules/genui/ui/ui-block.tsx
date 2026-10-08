// The Streamdown renderer for ```ui fences. Loaded lazily, so the parser,
// QuickJS client and components stay out of the chat bundle until an answer
// has a block. Every failure falls back to the block's source.

import {
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
  onActions: (actions: readonly BlockAction[], trusted: TrustedEvent) => void;
  onState: (state: string) => void;
}

/** A tree without its revisions: two renders that look and act the same compare equal. */
const shapeOf = (nodes: unknown) =>
  JSON.stringify(nodes, (key, value) => (key === "rev" ? 0 : value));

interface Queued {
  readonly handler: number;
  readonly args: readonly unknown[];
  readonly trusted: TrustedEvent;
  /** The tree the reader clicked in. */
  readonly shape: string;
}

function useBlock({
  client,
  block,
  code,
  streaming,
  now,
  persisted,
  onActions,
  onState,
}: BlockProps) {
  // What the reader saw last, from this session's memory or the device's
  // cache, so a remount or reload shows the block at once. It is not live:
  // its handlers belong to a runtime that is gone until the Worker redraws it.
  const [reply, setReply] = useState<RenderReply | Unavailable | null>(
    () => recall(block, code)?.reply ?? (streaming ? undefined : cachedTree(block, code)) ?? null,
  );
  const [live, setLive] = useState(false);
  // Replies are stamped with the Worker generation that produced them: a
  // restart makes every handler reference in the shown tree stale.
  const [stamp, setStamp] = useState(client.epoch());
  const epoch = useSyncExternalStore(client.subscribe, client.epoch, () => 0);
  const lastRender = useRef(0);
  // A click on a tree that is not live yet, replayed once it is.
  const queued = useRef<Queued | null>(null);
  const run = useRef<(tree: DrawnTree, handler: number, q: Queued, at: number) => void>(() => {});
  const startFrom = useCallback(
    () => recallState(block, code) ?? persisted,
    [block, code, persisted],
  );

  // The device cache may still have been loading when this mounted.
  useEffect(() => {
    if (streaming) return;
    let cancelled = false;
    void warmTrees().then(() => {
      const tree = cachedTree(block, code);
      if (!cancelled && tree) setReply((shown) => shown ?? tree);
    });
    return () => {
      cancelled = true;
    };
  }, [block, code, streaming]);

  const show = useCallback(
    (next: RenderReply | Unavailable, at: number, source: string) => {
      if (next.ok || next.reason !== "unavailable") remember(block, source, next);
      if (next.ok && !streaming) keepTree(block, source, next);
      setReply(next);
      setStamp(at);
      setLive(true);
      const click = queued.current;
      queued.current = null;
      // Only into the same tree: anything else would run a handler the reader never saw.
      if (click && next.ok && shapeOf(next.nodes) === click.shape) {
        run.current(next, click.handler, click, at);
      }
    },
    [block, streaming],
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
    run.current = (tree, handler, click, at) => {
      void client
        .call({ block, source: tree.source, rev: tree.rev, handler, args: click.args })
        .then(async (result) => {
          if (result.ok) {
            show(result.render, at, code);
            if (result.render.ok && result.render.state !== null) onState(result.render.state);
            onActions(result.actions, click.trusted);
          } else if ("stale" in result && result.stale) {
            show(await client.render({ block, code, saved: startFrom(), now }), at, code);
          }
        });
    };
  });

  const dispatch: Dispatch = useCallback(
    async (ref, args, trusted) => {
      if (!reply?.ok) return;
      const click = { handler: ref.$h, args, trusted, shape: shapeOf(reply.nodes) };
      if (!live) {
        queued.current = click;
        return;
      }
      if (stamp !== client.epoch() || ref.rev !== reply.rev) return;
      run.current(reply, ref.$h, click, client.epoch());
    },
    [client, live, reply, stamp],
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
      <Block
        client={client}
        block={block}
        ordinal={ordinal}
        code={code}
        streaming={incomplete || message.streaming}
        now={message.createdAt}
        persisted={persisted}
        onActions={onActions}
        onState={onState}
        suggest={suggest}
      />
      {dialog}
    </>
  );
}
