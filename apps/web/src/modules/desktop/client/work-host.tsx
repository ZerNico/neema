import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIdentityBoundary } from "~/modules/auth/identity-boundary.tsx";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Alert02Icon, NoInternetIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Effect, Schema } from "effect";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  claimDesktopTool,
  desktopWorkSnapshot,
  submitDesktopToolResult,
} from "../server/functions.ts";
import { abortWorkTurn, getWorkTurnReservation } from "~/modules/chat/server/functions.ts";
import { DesktopToolName, desktopFailure } from "../tool-schema.ts";
import { type ApprovalChoice, type PendingKind } from "./approvals.ts";
import { useDesktop } from "./bridge.ts";
import { executeDesktopTool } from "./execute-tool.ts";
import { WorkController } from "./work-controller.ts";

const WorkContext = createContext<{
  controller: WorkController | null;
  revision: number;
  paused: boolean;
}>({
  controller: null,
  revision: 0,
  paused: false,
});

export function DesktopWorkProvider({ children, userId }: { children: ReactNode; userId: string }) {
  const client = useDesktop();
  const boundary = useIdentityBoundary();
  const queryClient = useQueryClient();
  const [revision, setRevision] = useState(0);
  const [failedAfter, setFailedAfter] = useState<number | null>(null);
  const [reconciledClient, setReconciledClient] = useState<typeof client>(null);
  const reconciled = client === null || reconciledClient === client;
  useEffect(() => {
    let live = true;
    if (!client) return;
    void Effect.runPromise(client.listPendingPromotions(undefined))
      .then(async (pending) => {
        for (const item of pending) {
          let status;
          try {
            status = await getWorkTurnReservation({
              data: { reservationId: item.reservationId },
            });
          } catch {
            // The server may be offline or this origin may no longer own it.
            continue;
          }
          if (status.status === "activated") {
            await Effect.runPromise(
              client.commitPromotion({
                conversationId: item.conversationId,
                reservationId: item.reservationId,
              }),
            ).catch(() => {});
            continue;
          }
          if (status.status === "reserved") {
            try {
              await abortWorkTurn({ data: { reservationId: item.reservationId } });
            } catch {
              // The server may have accepted the abort. Keep the journal until
              // its state can be observed instead of deleting live files.
              continue;
            }
          }
          await Effect.runPromise(
            client.rollbackPromotion({
              conversationId: item.conversationId,
              reservationId: item.reservationId,
            }),
          ).catch(() => {});
          await Effect.runPromise(
            client.discardSubmission({
              conversationId: item.conversationId,
              submissionId: item.submissionId,
            }),
          ).catch(() => {});
        }
      })
      .finally(() => {
        if (live) setReconciledClient(client);
      });
    return () => {
      live = false;
    };
  }, [client]);
  const session = useQuery({
    queryKey: ["desktop-session"],
    enabled: !!client,
    queryFn: () => (client ? Effect.runPromise(client.executionSession(undefined)) : null),
    staleTime: Infinity,
  });
  const executorId = session.data?.id;
  const work = useQuery({
    queryKey: ["desktop-work", executorId],
    enabled: !!client && !!executorId,
    queryFn: () => desktopWorkSnapshot({ data: { executorId: executorId! } }),
  });

  const controller = useMemo(() => {
    if (!client || !executorId || !reconciled) return null;
    const report = (error: unknown) => {
      console.error("Background work connection failed", error);
      // Recording which snapshot was newest lets a later one disprove this.
      setFailedAfter(queryClient.getQueryState(["desktop-work", executorId])?.dataUpdatedAt ?? 0);
      void boundary?.reconcile();
    };
    return new WorkController({
      claim: async (call) => (await claimDesktopTool({ data: call })).token,
      execute: (call, remainingMs) =>
        Schema.is(DesktopToolName)(call.name)
          ? Effect.runPromise(
              executeDesktopTool(client, call.conversationId, remainingMs, {
                callId: call.callId,
                name: call.name,
                args: call.args,
              }),
            )
          : Promise.resolve(desktopFailure("That did not run", "Unknown local tool.")),
      complete: async (call, token, result) => {
        const response = await submitDesktopToolResult({ data: { ...call, token, result } });
        setFailedAfter(null);
        void queryClient.invalidateQueries({ queryKey: ["desktop-work"] });
        return response.accepted;
      },
      cancel: (callId) => {
        void Effect.runPromise(client.cancelCall({ callId })).catch(report);
      },
      changed: () => setRevision((current) => current + 1),
      error: report,
    });
  }, [client, executorId, reconciled, queryClient, boundary]);
  // A snapshot that arrived after the failure disproves it, so any answered
  // request clears this, not only a delivered result.
  const stale = failedAfter !== null && failedAfter >= work.dataUpdatedAt;
  const unreachable = !!client && (stale || work.isError || session.isError);
  // Telling someone their work stopped when none was running invents a worry.
  // The last successful snapshot is the only evidence there was any; without
  // one, nothing is known to have been interrupted.
  const paused =
    unreachable && !!work.data && work.data.attempts.length + work.data.calls.length > 0;
  const host = useMemo(() => ({ controller, revision, paused }), [controller, revision, paused]);

  useEffect(() => {
    if (!unreachable) return;
    // Nothing polls the snapshot any more, so a failure has to fetch its own
    // disproof. Success clears the state below and this loop stops with it.
    const refetch = () => {
      if (session.isError) void queryClient.refetchQueries({ queryKey: ["desktop-session"] });
      void queryClient.refetchQueries({ queryKey: ["desktop-work"] });
    };
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          schedule();
          refetch();
        },
        Math.min(2000 * 2 ** attempt++, 30_000),
      );
    };
    schedule();
    window.addEventListener("online", refetch);
    window.addEventListener("focus", refetch);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("online", refetch);
      window.removeEventListener("focus", refetch);
    };
  }, [unreachable, session.isError, queryClient]);

  useEffect(() => {
    if (!controller || !client) return;
    controller.activate();
    const pagehide = () => controller.dispose();
    window.addEventListener("pagehide", pagehide);
    return () => {
      window.removeEventListener("pagehide", pagehide);
      controller.dispose();
      void Effect.runPromise(client.setWorkState({ active: 0, needsApproval: 0 })).catch((error) =>
        console.error("Could not clear work status", error),
      );
    };
  }, [controller, client]);

  useEffect(() => {
    // A fresh, identical snapshot still retries failed result delivery.
    if (!work.dataUpdatedAt) return;
    if (work.data?.attempts.some((attempt) => attempt.userId !== userId)) {
      host.controller?.dispose();
      void boundary?.reconcile();
      return;
    }
    if (host.controller && work.data)
      host.controller.reconcile({
        ...work.data,
        calls: work.data.calls.map((call) => ({
          ...call,
          args: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
            JSON.parse(call.args),
          ),
        })),
      });
  }, [host.controller, work.data, work.dataUpdatedAt, userId, boundary]);

  useEffect(() => {
    if (!client) return;
    void Effect.runPromise(
      client.setWorkState({
        active: work.data?.attempts.length ?? 0,
        needsApproval: host.controller?.attention().reduce((n, item) => n + item.pending, 0) ?? 0,
      }),
    ).catch((error) => console.error("Could not update desktop work status", error));
  }, [client, work.data, host]);

  return <WorkContext value={host}>{children}</WorkContext>;
}

/** Rendered in the content column, not here: the provider sits above the sidebar. */
export function WorkConnectionNotice() {
  const { paused } = useContext(WorkContext);
  if (!paused) return null;
  return (
    <div
      role="status"
      className="border-warning/50 bg-warning/10 flex shrink-0 items-center gap-2 border-b px-3 py-2 text-sm"
    >
      <HugeiconsIcon
        icon={NoInternetIcon}
        strokeWidth={2}
        className="text-warning size-4 shrink-0"
        aria-hidden
      />
      Can’t reach the server, so work on this computer is paused until the connection is back.
    </div>
  );
}

/**
 * Stable until the controller reports a change: this feeds the message list's
 * display memo, so a fresh object per render would re-render every message on
 * every stream chunk.
 */
export function useWorkApprovals(conversationId: string) {
  const { controller, revision } = useContext(WorkContext);
  return useMemo(
    () => ({
      pending: controller?.pending(conversationId) ?? new Map<string, PendingKind>(),
      decide: (callId: string, choice: ApprovalChoice) => controller?.decide(callId, choice),
      /** The controller's change counter, so this value is new exactly when its contents are. */
      revision,
    }),
    [controller, conversationId, revision],
  );
}

export function WorkAttention() {
  const host = useContext(WorkContext);
  const { controller } = host;
  const attention = useMemo(() => host.controller?.attention() ?? [], [host]);
  const { conversationId } = useParams({ strict: false });
  const navigate = useNavigate();
  const notices = useRef(new Map<string, { calls: Set<string>; toastId: string | number }>());

  useEffect(() => {
    if (!controller) return;
    const owned = notices.current;
    return () => {
      for (const notice of owned.values()) toast.dismiss(notice.toastId);
      owned.clear();
    };
  }, [controller]);

  useEffect(() => {
    for (const [id, notice] of notices.current) {
      if (!attention.some((item) => item.conversationId === id)) {
        toast.dismiss(notice.toastId);
        notices.current.delete(id);
      }
    }
    for (const item of attention) {
      const id = item.conversationId;
      const previous = notices.current.get(id);
      if (id === conversationId) {
        if (previous) toast.dismiss(previous.toastId);
        continue;
      }
      const calls = new Set(controller!.pending(id).keys());
      // Dismissal and snapshot refreshes must not announce the same calls again.
      if (previous && [...calls].every((callId) => previous.calls.has(callId))) continue;
      const toastId = toast.warning("Work needs your approval", {
        ...(previous ? { id: previous.toastId } : {}),
        description: item.title || "Work chat",
        closeButton: true,
        duration: 8000,
        action: {
          label: "Review",
          onClick: () => {
            void navigate({ to: "/chat/$conversationId", params: { conversationId: id } });
          },
        },
      });
      notices.current.set(id, { calls, toastId });
    }
  }, [controller, attention, conversationId, navigate]);
  const count = attention.reduce((total, item) => total + item.pending, 0);
  if (!count) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="sm" className="ml-auto" />}
        aria-label={`Review work approvals (${count})`}
      >
        <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-4" aria-hidden />
        Approvals
        <span className="text-muted-foreground tabular-nums">{count}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {attention.map((item) => (
          <DropdownMenuItem
            key={item.conversationId}
            onClick={() => {
              void navigate({
                to: "/chat/$conversationId",
                params: { conversationId: item.conversationId },
              });
            }}
          >
            <span className="min-w-0 flex-1 truncate">{item.title || "Work chat"}</span>
            <span className="text-muted-foreground tabular-nums">{item.pending}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
