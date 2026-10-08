// The Streamdown renderer for ```ui fences. Loaded lazily, so the parser,
// QuickJS client and components stay out of the chat bundle until an answer
// has a block. Every failure falls back to the block's source.

import { use, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CustomRendererProps } from "streamdown";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "~/ui/disclosure.tsx";
import { disclosureTriggerClassName } from "~/ui/disclosure-classes.ts";
import { focusRingClassName } from "~/ui/focus-ring.ts";
import { cn } from "~/ui/utils";
import { Skeleton } from "~/ui/primitives/skeleton";
import type { RenderReply } from "../client/engine.ts";
import { sharedWorkerClient, type GenuiClient, type Unavailable } from "../client/host.ts";
import { recall, recallState, remember } from "../client/memory.ts";
import { fenceKey } from "../fences.ts";
import {
  DispatchContext,
  GenuiClientContext,
  GenuiMessageContext,
  type Dispatch,
} from "./context.ts";
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

function ShowSource({ code }: { code: string }) {
  return (
    <Disclosure>
      <DisclosureTrigger className={cn(disclosureTriggerClassName, focusRingClassName)}>
        Show source
      </DisclosureTrigger>
      <DisclosureContent>
        <div className="pt-2">
          <Source code={code} />
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}

const noop = () => () => {};

function useBlock(
  client: GenuiClient,
  block: string,
  code: string,
  streaming: boolean,
  now: number,
) {
  const [reply, setReply] = useState<RenderReply | Unavailable | null>(
    () => recall(block, code)?.reply ?? null,
  );
  // Replies are stamped with the Worker generation that produced them: a
  // restart makes every handler reference in the shown tree stale.
  const [stamp, setStamp] = useState(client.epoch());
  const epoch = useSyncExternalStore(client.subscribe, client.epoch, () => 0);
  const lastRender = useRef(0);

  const show = useCallback(
    (next: RenderReply | Unavailable, at: number, source: string) => {
      if (next.ok || next.reason !== "unavailable") remember(block, source, next);
      setReply(next);
      setStamp(at);
    },
    [block],
  );

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      lastRender.current = Date.now();
      const at = client.epoch();
      void client.render({ block, code, saved: recallState(block, code), now }).then((next) => {
        if (!cancelled) show(next, at, code);
      });
    };
    const wait = streaming ? Math.max(0, lastRender.current + STREAMING_RENDER_MS - Date.now()) : 0;
    const timer = setTimeout(run, wait);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- epoch re-renders the block in a restarted Worker
  }, [client, block, code, streaming, now, epoch, show]);

  useEffect(() => () => client.release(block), [client, block]);

  const dispatch: Dispatch = useCallback(
    async (ref, args) => {
      if (stamp !== client.epoch()) return;
      const at = client.epoch();
      const result = await client.call({ block, rev: ref.rev, handler: ref.$h, args });
      if (result.ok) show(result.render, at, code);
      else if ("stale" in result && result.stale) {
        const next = await client.render({ block, code, saved: recallState(block, code), now });
        show(next, at, code);
      }
    },
    [client, block, code, now, stamp, show],
  );

  return { reply, dispatch };
}

function Block({
  client,
  block,
  code,
  streaming,
  now,
}: {
  client: GenuiClient;
  block: string;
  code: string;
  streaming: boolean;
  now: number;
}) {
  const { reply, dispatch } = useBlock(client, block, code, streaming, now);
  if (reply === null || (!reply.ok && reply.reason === "incomplete")) {
    return <Skeleton className="h-24 w-full" />;
  }
  if (!reply.ok) {
    // Still being written, a failure is most likely a half-sent expression.
    if (streaming) return <Skeleton className="h-24 w-full" />;
    return <Source code={code} />;
  }
  return (
    <div className="flex flex-col gap-2" data-genui-block={block}>
      <DispatchContext value={dispatch}>
        <div className="flex flex-col gap-3">
          <Nodes nodes={reply.nodes} />
        </div>
      </DispatchContext>
      {streaming ? null : <ShowSource code={code} />}
    </div>
  );
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
  if (!hydrated && !injected) return <Skeleton className="h-24 w-full" />;
  const client = injected ?? sharedWorkerClient();
  return (
    <Block
      client={client}
      block={`${message.messageId}:${key}`}
      code={code}
      streaming={isIncomplete || message.streaming}
      now={message.createdAt}
    />
  );
}
