import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIdentityBoundary } from "~/modules/auth/identity-context.ts";
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
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  claimDesktopTool,
  desktopWorkSnapshot,
  submitDesktopToolResult,
} from "../server/functions.ts";
import {
  abortWorkTurn,
  dispatchQueuedMessage,
  getWorkTurnReservation,
} from "~/modules/chat/server/functions.ts";
import { readDesktopBrowser } from "@chat/desktop-rpc";
import { browserTabs } from "~/modules/browser/client/browser-store.ts";
import { cancelBrowserCall, executeBrowserTool } from "~/modules/browser/client/execute-browser.ts";
import { isBrowserTool } from "~/modules/browser/tool-schema.ts";
import { DesktopToolName, desktopFailure } from "../tool-schema.ts";
import { sendFieldsFor, useDesktop } from "./bridge.ts";
import { executeDesktopTool } from "./execute-tool.ts";
import { WorkController } from "./work-controller.ts";
import { WorkContext } from "./work-context.ts";

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
    // Browser calls run in this page's own tabs; a shell without the agent
    // surface never had the tools offered, so none should arrive.
    const agentBrowser = () => {
      const browser = readDesktopBrowser();
      return browser?.agent ? { browser, agent: browser.agent } : null;
    };
    // A site call's address, with the desktop that decides about it.
    const siteCall = (call: { args: Readonly<Record<string, unknown>> }) => {
      const agent = agentBrowser()?.agent;
      const { url } = call.args;
      return agent && typeof url === "string" ? { agent, url } : null;
    };
    return new WorkController({
      claim: async (call) => (await claimDesktopTool({ data: call })).token,
      execute: (call, remainingMs, askSite, scope) => {
        const { name } = call;
        if (!Schema.is(DesktopToolName)(name))
          return Promise.resolve(desktopFailure("That did not run", "Unknown local tool."));
        if (!isBrowserTool(name))
          return Effect.runPromise(
            executeDesktopTool(client, call.conversationId, remainingMs, {
              callId: call.callId,
              generationId: call.generationId,
              name,
              args: call.args,
              scope,
            }),
          );
        const embedded = agentBrowser();
        return embedded
          ? executeBrowserTool({ ...call, name }, remainingMs, {
              ...embedded,
              askSite,
              saveToWorkspace: (file) =>
                Effect.runPromise(
                  Effect.map(
                    client.saveToWorkspace({
                      callId: call.callId,
                      conversationId: call.conversationId,
                      fileName: file.name,
                      base64: file.base64,
                    }),
                    (receipt) => receipt.path,
                  ),
                ),
            })
          : Promise.resolve(
              desktopFailure("No browser here", "This desktop app cannot use a browser."),
            );
      },
      siteAllowed: (call) => {
        const site = siteCall(call);
        return site
          ? site.agent.siteAllowed(call.conversationId, site.url)
          : Promise.resolve(false);
      },
      allowSite: (call, scope) => {
        const site = siteCall(call);
        return site
          ? site.agent.allowSite(call.conversationId, site.url, scope)
          : Promise.resolve();
      },
      complete: async (call, token, result) => {
        const response = await submitDesktopToolResult({ data: { ...call, token, result } });
        setFailedAfter(null);
        void queryClient.invalidateQueries({ queryKey: ["desktop-work"] });
        return response.accepted;
      },
      cancel: (callId) => {
        cancelBrowserCall(callId);
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
      void Effect.runPromise(
        client.setWorkState({ active: 0, needsApproval: 0, attempts: [] }),
      ).catch((error) => console.error("Could not clear work status", error));
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
    // A chat whose answer is running here keeps its pages fully alive.
    browserTabs.setHeld(
      new Set(work.data?.attempts.map((attempt) => attempt.conversationId) ?? []),
    );
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

  // Queued Work waits for a machine, and this app is one. Each start reads the
  // folders now and names this app's executor; the server's lock decides. Like
  // tool work it waits for pending file promotions, so a reserved turn's
  // activation never loses its chat to a queued message.
  const starting = useRef(new Set<string>());
  useEffect(() => {
    if (!client || !executorId || !reconciled || !work.data) return;
    for (const conversationId of work.data.queued) {
      if (starting.current.has(conversationId)) continue;
      starting.current.add(conversationId);
      void Effect.runPromise(client.folderStatus({ conversationId }))
        .then((status) =>
          dispatchQueuedMessage({
            data: { conversationId, ...sendFieldsFor(status), desktopExecutorId: executorId },
          }),
        )
        .catch((error: unknown) => console.error("Could not start queued work", error))
        .finally(() => starting.current.delete(conversationId));
    }
  }, [client, executorId, reconciled, work.data]);

  useEffect(() => {
    if (!client) return;
    void Effect.runPromise(
      client.setWorkState({
        active: work.data?.attempts.length ?? 0,
        attempts: (work.data?.attempts ?? []).map(({ conversationId, generationId }) => ({
          conversationId,
          generationId,
        })),
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

export function WorkAttention() {
  // Reads the controller, which changes in place, again on every `revision`; see useWorkApprovals.
  "use no memo";
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
