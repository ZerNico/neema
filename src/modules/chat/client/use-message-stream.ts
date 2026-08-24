import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef } from "react";
import { useSmoothText } from "./use-smooth-text.ts";

export interface ToolPageStatus {
  url: string;
  title?: string;
  status: "pending" | "reading" | "done" | "error";
  error?: string;
}

// A citable source. `index` is message-global, so chips and the sources panel
// can key off it directly across multiple searches.
export interface ToolSource {
  index: number;
  url: string;
  title: string;
  snippet: string;
  read: boolean;
}

// Live view of one tool call, upserted by callId from tool chunk envelopes.
export interface ToolActivity {
  callId: string;
  name: string;
  turnIndex?: number;
  callIndex?: number;
  targets: string[];
  status: "running" | "complete" | "error";
  resultCount?: number;
  pagesFetched?: number;
  pages?: ToolPageStatus[];
  sources?: ToolSource[];
  error?: string;
}

// One durable/live compaction occurrence. Position is relative to model/tool
// turns inside this assistant response, not to the historical checkpoint it
// may have produced.
export interface CompactionActivity {
  eventId: string;
  beforeTurnIndex: number;
  passIndex: number;
  scope: "history" | "active_rounds";
  status: "running" | "complete" | "failed";
  outcome?: "summary" | "hard_truncation";
  summary?: string;
}

export interface StreamState {
  /** Visible answer text accumulated from chunks. */
  text: string;
  /** Reasoning/thinking text; stays empty for hidden-reasoning providers. */
  reasoning: string;
  /** True once any reasoning chunk arrived (even empty hidden markers). */
  reasoningSeen: boolean;
  tools: ToolActivity[];
  /** Usually empty; one response may compact at several turn boundaries. */
  compactions: CompactionActivity[];
  lastSeq: number;
  status: "idle" | "streaming" | "complete" | "error" | "aborted";
}

type Action =
  | {
      kind: "reset";
      text: string;
      reasoning: string;
      reasoningSeen: boolean;
      tools: ToolActivity[];
      compactions: CompactionActivity[];
      lastSeq: number;
    }
  | {
      kind: "chunk";
      seq: number;
      chunkKind: "text" | "reasoning" | "tool" | "compaction";
      delta: string;
    }
  | { kind: "done"; status: "complete" | "error" | "aborted" };

// Parses a tool chunk envelope defensively: malformed rows must not crash the
// stream; the chunk still advances lastSeq so resume cursors stay correct.
export function applyToolChunk(tools: ToolActivity[], delta: string): ToolActivity[] {
  let envelope: unknown;
  try {
    envelope = JSON.parse(delta);
  } catch {
    return tools;
  }
  const e = envelope as {
    v?: number;
    phase?: string;
    callId?: string;
    name?: string;
    turnIndex?: number;
    callIndex?: number;
    args?: { targets?: string[] };
    ok?: boolean;
    summary?: { targets?: string[]; resultCount?: number; pagesFetched?: number };
    pages?: ToolPageStatus[];
    sources?: ToolSource[];
    error?: string;
  };
  if (e.v !== 1 || !e.callId || !e.name) return tools;

  const upsert = (next: Partial<ToolActivity> & { callId: string; name: string }) => {
    const idx = tools.findIndex((t) => t.callId === next.callId);
    if (idx === -1) {
      return [
        ...tools,
        {
          targets: [],
          status: "running" as const,
          turnIndex: e.turnIndex ?? 0,
          callIndex: e.callIndex ?? tools.length,
          ...next,
        },
      ];
    }
    return tools.map((t, i) => (i === idx ? { ...t, ...next } : t));
  };

  if (e.phase === "start") {
    if (tools.some((t) => t.callId === e.callId)) return tools;
    return [
      ...tools,
      {
        callId: e.callId,
        name: e.name,
        turnIndex: e.turnIndex ?? 0,
        callIndex: e.callIndex ?? tools.length,
        targets: e.args?.targets ?? [],
        status: "running",
      },
    ];
  }
  if (e.phase === "progress") {
    return upsert({
      callId: e.callId,
      name: e.name,
      status: "running",
      ...(e.summary?.targets ? { targets: e.summary.targets } : {}),
      ...(e.summary?.resultCount !== undefined ? { resultCount: e.summary.resultCount } : {}),
      ...(e.pages !== undefined ? { pages: e.pages } : {}),
    });
  }
  if (e.phase === "result") {
    return upsert({
      callId: e.callId,
      name: e.name,
      targets: e.summary?.targets ?? [],
      status: e.ok ? "complete" : "error",
      ...(e.summary?.resultCount !== undefined ? { resultCount: e.summary.resultCount } : {}),
      ...(e.summary?.pagesFetched !== undefined ? { pagesFetched: e.summary.pagesFetched } : {}),
      ...(e.pages !== undefined ? { pages: e.pages } : {}),
      ...(e.sources !== undefined ? { sources: e.sources } : {}),
      ...(e.error !== undefined ? { error: e.error } : {}),
    });
  }
  return tools;
}

// Same defensive contract as `applyToolChunk`: a malformed envelope leaves the
// state alone, and replaying the same marker twice is a no-op.
export function applyCompactionChunk(
  current: CompactionActivity[],
  delta: string,
): CompactionActivity[] {
  let envelope: unknown;
  try {
    envelope = JSON.parse(delta);
  } catch {
    return current;
  }
  const e = envelope as {
    v?: number;
    phase?: string;
    eventId?: string;
    beforeTurnIndex?: number;
    passIndex?: number;
    scope?: "history" | "active_rounds";
    ok?: boolean;
    outcome?: "summary" | "hard_truncation";
    summary?: string;
  };
  if (
    e.v !== 1 ||
    !e.eventId ||
    e.beforeTurnIndex === undefined ||
    e.passIndex === undefined ||
    !e.scope
  ) {
    return current;
  }

  const index = current.findIndex((activity) => activity.eventId === e.eventId);
  const existing = index === -1 ? undefined : current[index];
  if (e.phase === "start" && existing && existing.status !== "running") return current;
  const next: CompactionActivity = {
    eventId: e.eventId,
    beforeTurnIndex: e.beforeTurnIndex,
    passIndex: e.passIndex,
    scope: e.scope,
    status: e.phase === "result" ? (e.ok ? "complete" : "failed") : (existing?.status ?? "running"),
    ...(e.outcome
      ? { outcome: e.outcome }
      : existing?.outcome
        ? { outcome: existing.outcome }
        : {}),
    ...(typeof e.summary === "string"
      ? { summary: e.summary }
      : existing?.summary
        ? { summary: existing.summary }
        : {}),
  };
  if (e.phase !== "start" && e.phase !== "result") return current;
  const activities =
    index === -1
      ? [...current, next]
      : current.map((activity, i) => (i === index ? next : activity));
  // oxlint-disable-next-line no-array-sort -- fresh array
  return [...activities].sort(
    (a, b) => a.beforeTurnIndex - b.beforeTurnIndex || a.passIndex - b.passIndex,
  );
}

function reducer(state: StreamState, action: Action): StreamState {
  switch (action.kind) {
    case "reset":
      return {
        text: action.text,
        reasoning: action.reasoning,
        reasoningSeen: action.reasoningSeen,
        tools: action.tools,
        compactions: action.compactions,
        lastSeq: action.lastSeq,
        status: "streaming",
      };
    case "chunk": {
      if (action.seq <= state.lastSeq) return state;
      if (action.chunkKind === "reasoning") {
        return {
          ...state,
          reasoning: state.reasoning + action.delta,
          reasoningSeen: true,
          lastSeq: action.seq,
        };
      }
      if (action.chunkKind === "compaction") {
        return {
          ...state,
          compactions: applyCompactionChunk(state.compactions, action.delta),
          lastSeq: action.seq,
        };
      }
      if (action.chunkKind === "tool") {
        return {
          ...state,
          tools: applyToolChunk(state.tools, action.delta),
          lastSeq: action.seq,
        };
      }
      return { ...state, text: state.text + action.delta, lastSeq: action.seq };
    }
    case "done":
      return { ...state, status: action.status };
  }
}

export interface InitialStream {
  text: string;
  reasoning: string;
  reasoningSeen: boolean;
  tools: ToolActivity[];
  compactions: CompactionActivity[];
  lastSeq: number;
}

// Subscribes to a streaming assistant message with resume support.
// `initial` carries chunks already loaded via the conversation query, so the
// SSE connection only replays what happened after them (?after=<seq>).
export function useMessageStream(
  messageId: string | null,
  initial: InitialStream | null,
  conversationId: string | null,
  /**
   * Bump to force a fresh subscription for the SAME message id — retry reuses
   * the row, so the id alone can't signal "this is a new generation".
   */
  epoch = 0,
) {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(reducer, {
    text: initial?.text ?? "",
    reasoning: initial?.reasoning ?? "",
    reasoningSeen: initial?.reasoningSeen ?? false,
    tools: initial?.tools ?? [],
    compactions: initial?.compactions ?? [],
    lastSeq: initial?.lastSeq ?? 0,
    status: messageId ? "streaming" : "idle",
  });
  // Reset when the target generation changes (navigation between chats, or a
  // retry of the same message).
  const activeRef = useRef<string | null>(null);

  useEffect(() => {
    if (!messageId) {
      activeRef.current = null;
      return;
    }
    const generationKey = `${messageId}:${epoch}`;
    if (activeRef.current !== generationKey) {
      activeRef.current = generationKey;
      dispatch({
        kind: "reset",
        text: initial?.text ?? "",
        reasoning: initial?.reasoning ?? "",
        reasoningSeen: initial?.reasoningSeen ?? false,
        tools: initial?.tools ?? [],
        compactions: initial?.compactions ?? [],
        lastSeq: initial?.lastSeq ?? 0,
      });
    }

    const after = initial?.lastSeq ?? 0;
    const source = new EventSource(`/api/messages/${messageId}/stream?after=${after}`);

    source.addEventListener("chunk", (raw) => {
      const data = JSON.parse((raw as MessageEvent).data) as {
        seq: number;
        kind?: "text" | "reasoning" | "tool" | "compaction";
        delta: string;
      };
      dispatch({ kind: "chunk", seq: data.seq, chunkKind: data.kind ?? "text", delta: data.delta });
    });

    source.addEventListener("done", (raw) => {
      const data = JSON.parse((raw as MessageEvent).data) as {
        status: "complete" | "error" | "aborted";
      };
      dispatch({ kind: "done", status: data.status });
      source.close();
      // Errors and stops refresh the canonical row immediately — feedback
      // outranks pacing. A normal completion holds the refetch until the
      // smoothed view drains (the effect below): swapping in the row's full
      // content early would be exactly the end-of-stream pop smoothing
      // exists to remove.
      if (data.status !== "complete" && conversationId) {
        void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
      }
    });

    source.onerror = () => {
      // EventSource auto-reconnects; nothing to do. If the server is gone the
      // browser keeps retrying, which is the desired resume behavior.
    };

    return () => source.close();
    // initial is intentionally captured only when the generation changes
  }, [messageId, epoch, conversationId, queryClient]);

  // The reducer accumulates raw deltas (lastSeq must track receipt exactly —
  // resume depends on it); only the strings the UI renders are word-paced.
  const text = useSmoothText(state.text);
  const reasoning = useSmoothText(state.reasoning);
  const drained = text === state.text && reasoning === state.reasoning;

  // Deferred half of the done handler: once the display has caught up,
  // refresh the canonical message row (final content, usage, status). The
  // messageId guard keeps the refetch from re-firing after it lands (the
  // streaming row disappears, so messageId goes null) or on navigation.
  useEffect(() => {
    if (state.status !== "complete" || !drained || !messageId || !conversationId) return;
    void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
  }, [state.status, drained, messageId, conversationId, queryClient]);

  return {
    ...state,
    text,
    reasoning,
    // Completion is only reported once the words are all on screen; the
    // pacer keeps advancing regardless of status, so this converges within
    // ticks of the real finish. Errors and stops pass through undelayed.
    status: state.status === "complete" && !drained ? ("streaming" as const) : state.status,
  };
}
