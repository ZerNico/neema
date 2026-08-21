import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef } from "react";

export interface StreamState {
  /** Text accumulated from chunks, keyed nowhere — single active stream per hook. */
  text: string;
  lastSeq: number;
  status: "idle" | "streaming" | "complete" | "error" | "aborted";
}

type Action =
  | { kind: "reset"; text: string; lastSeq: number }
  | { kind: "chunk"; seq: number; delta: string }
  | { kind: "done"; status: "complete" | "error" | "aborted" };

function reducer(state: StreamState, action: Action): StreamState {
  switch (action.kind) {
    case "reset":
      return { text: action.text, lastSeq: action.lastSeq, status: "streaming" };
    case "chunk":
      if (action.seq <= state.lastSeq) return state;
      return { ...state, text: state.text + action.delta, lastSeq: action.seq };
    case "done":
      return { ...state, status: action.status };
  }
}

// Subscribes to a streaming assistant message with resume support.
// `initial` carries chunks already loaded via the conversation query, so the
// SSE connection only replays what happened after them (?after=<seq>).
export function useMessageStream(
  messageId: string | null,
  initial: { text: string; lastSeq: number } | null,
  conversationId: string | null,
) {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(reducer, {
    text: initial?.text ?? "",
    lastSeq: initial?.lastSeq ?? 0,
    status: messageId ? "streaming" : "idle",
  });
  // Reset when the target message changes (e.g. navigation between chats).
  const activeRef = useRef<string | null>(null);

  useEffect(() => {
    if (!messageId) return;
    if (activeRef.current !== messageId) {
      activeRef.current = messageId;
      dispatch({ kind: "reset", text: initial?.text ?? "", lastSeq: initial?.lastSeq ?? 0 });
    }

    const after = initial?.lastSeq ?? 0;
    const source = new EventSource(`/api/messages/${messageId}/stream?after=${after}`);

    source.addEventListener("chunk", (raw) => {
      const data = JSON.parse((raw as MessageEvent).data) as { seq: number; delta: string };
      dispatch({ kind: "chunk", seq: data.seq, delta: data.delta });
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
