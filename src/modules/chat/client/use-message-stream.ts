import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef } from "react";

export interface StreamState {
  /** Visible answer text accumulated from chunks. */
  text: string;
  /** Reasoning/thinking text; stays empty for hidden-reasoning providers. */
  reasoning: string;
  /** True once any reasoning chunk arrived (even empty hidden markers). */
  reasoningSeen: boolean;
  lastSeq: number;
  status: "idle" | "streaming" | "complete" | "error" | "aborted";
}

type Action =
  | { kind: "reset"; text: string; reasoning: string; reasoningSeen: boolean; lastSeq: number }
  | { kind: "chunk"; seq: number; chunkKind: "text" | "reasoning"; delta: string }
  | { kind: "done"; status: "complete" | "error" | "aborted" };

function reducer(state: StreamState, action: Action): StreamState {
  switch (action.kind) {
    case "reset":
      return {
        text: action.text,
        reasoning: action.reasoning,
        reasoningSeen: action.reasoningSeen,
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
  lastSeq: number;
}

// Subscribes to a streaming assistant message with resume support.
// `initial` carries chunks already loaded via the conversation query, so the
// SSE connection only replays what happened after them (?after=<seq>).
export function useMessageStream(
  messageId: string | null,
  initial: InitialStream | null,
  conversationId: string | null,
) {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(reducer, {
    text: initial?.text ?? "",
    reasoning: initial?.reasoning ?? "",
    reasoningSeen: initial?.reasoningSeen ?? false,
    lastSeq: initial?.lastSeq ?? 0,
    status: messageId ? "streaming" : "idle",
  });
  // Reset when the target message changes (e.g. navigation between chats).
  const activeRef = useRef<string | null>(null);

  useEffect(() => {
    if (!messageId) return;
    if (activeRef.current !== messageId) {
      activeRef.current = messageId;
      dispatch({
        kind: "reset",
        text: initial?.text ?? "",
        reasoning: initial?.reasoning ?? "",
        reasoningSeen: initial?.reasoningSeen ?? false,
        lastSeq: initial?.lastSeq ?? 0,
      });
    }

    const after = initial?.lastSeq ?? 0;
    const source = new EventSource(`/api/messages/${messageId}/stream?after=${after}`);

    source.addEventListener("chunk", (raw) => {
      const data = JSON.parse((raw as MessageEvent).data) as {
        seq: number;
        kind?: "text" | "reasoning";
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
      // Refresh the canonical message row (final content, usage, status).
      if (conversationId) {
        void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
      }
    });

    source.onerror = () => {
      // EventSource auto-reconnects; nothing to do. If the server is gone the
      // browser keeps retrying, which is the desired resume behavior.
    };

    return () => source.close();
    // initial is intentionally captured only when messageId changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId, conversationId, queryClient]);

  return state;
}
