import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIdentityBoundary } from "~/modules/auth/identity-boundary.tsx";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Alert02Icon } from "@hugeicons/core-free-icons";
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
import { DesktopToolName, desktopFailure } from "../tool-schema.ts";
import { type ApprovalChoice, type PendingKind } from "./approvals.ts";
import { useDesktop, waitForDraftBinding } from "./bridge.ts";
import { executeDesktopTool } from "./execute-tool.ts";
import { WorkController } from "./work-controller.ts";

const WorkContext = createContext<{ controller: WorkController | null; revision: number }>({
  controller: null,
  revision: 0,
});

export function DesktopWorkProvider({ children, userId }: { children: ReactNode; userId: string }) {
  const client = useDesktop();
  const boundary = useIdentityBoundary();
  const queryClient = useQueryClient();
  const [revision, setRevision] = useState(0);
  const [failure, setFailure] = useState(false);
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
    refetchInterval: (query) => (query.state.data?.attempts.length ? 1500 : 15000),
    refetchIntervalInBackground: true,
  });

  const controller = useMemo(() => {
    if (!client || !executorId) return null;
    const report = (error: unknown) => {
      console.error("Background work connection failed", error);
      setFailure(true);
      void boundary?.reconcile();
    };
    return new WorkController({
      beforeExecute: waitForDraftBinding,
      claim: async (call) => (await claimDesktopTool({ data: call })).token,
      execute: (call, network) =>
        Schema.is(DesktopToolName)(call.name)
          ? Effect.runPromise(
              executeDesktopTool(client, call.conversationId, network, {
                callId: call.callId,
                name: call.name,
                args: call.args,
              }),
            )
          : Promise.resolve(desktopFailure("That did not run", "Unknown local tool.")),
      complete: async (call, token, result) => {
        await submitDesktopToolResult({ data: { ...call, token, result } });
        setFailure(false);
        void queryClient.invalidateQueries({ queryKey: ["desktop-work"] });
      },
      cancel: (callId) => {
        void Effect.runPromise(client.cancelCall({ callId })).catch(report);
      },
      changed: () => setRevision((current) => current + 1),
      error: report,
    });
  }, [client, executorId, queryClient, boundary]);
  const host = useMemo(() => ({ controller, revision }), [controller, revision]);

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

  return (
    <WorkContext value={host}>
      {(failure || work.isError || session.isError) && client && (
        <div role="status" className="bg-muted text-muted-foreground px-3 py-2 text-sm">
          Work is waiting for a connection. Completed actions won’t be repeated.
        </div>
      )}
      {children}
    </WorkContext>
  );
}

export function useWorkApprovals(conversationId: string) {
  const { controller } = useContext(WorkContext);
  return {
    pending: controller?.pending(conversationId) ?? new Map<string, PendingKind>(),
    decide: (callId: string, choice: ApprovalChoice) => controller?.decide(callId, choice),
  };
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
