import type { NetworkLevel } from "@chat/desktop-rpc";
import type { PermissionLevel } from "~/modules/chat/schema.ts";
import type {
  ExternalOperation,
  ExternalOwner,
} from "~/modules/tools/server/external-completion.ts";
import {
  approvalKind,
  desktopFailure,
  type DesktopToolName,
  type DesktopToolResult,
} from "../tool-schema.ts";
import type { ApprovalChoice, PendingKind } from "./approvals.ts";

export interface WorkSnapshot {
  attempts: ExternalOwner[];
  calls: ExternalOperation[];
  settings: {
    conversationId: string;
    title: string | null;
    approval: PermissionLevel;
    network: NetworkLevel;
  }[];
}
export interface WorkDependencies {
  claim(call: ExternalOperation): Promise<string | null>;
  execute(call: ExternalOperation, network: NetworkLevel): Promise<DesktopToolResult>;
  complete(call: ExternalOperation, token: string, result: DesktopToolResult): Promise<boolean>;
  cancel(callId: string): void;
  beforeExecute(): Promise<void>;
  changed(): void;
  error(error: unknown): void;
}
interface Entry {
  call: ExternalOperation;
  pending: PendingKind | null;
  permitted?: boolean;
  result?: DesktopToolResult;
  busy: boolean;
  delivered?: boolean;
  retries: number;
  retry?: ReturnType<typeof setTimeout> | undefined;
  deadline: ReturnType<typeof setTimeout>;
}

// One instance per authenticated document, not per chat route. IPC owns replay
// across document reloads; this controller owns consent and result delivery.
export class WorkController {
  private entries = new Map<string, Entry>();
  private grants = new Map<string, Set<PendingKind>>();
  private snapshot: WorkSnapshot = { attempts: [], calls: [], settings: [] };
  private disposed = false;
  constructor(private readonly deps: WorkDependencies) {}

  activate() {
    this.disposed = false;
  }

  reconcile(snapshot: WorkSnapshot) {
    if (this.disposed) return;
    this.snapshot = snapshot;
    const live = new Set(
      snapshot.calls.filter((c) => c.expiresAt > Date.now()).map((c) => c.callId),
    );
    for (const [id] of this.entries) if (!live.has(id)) this.cancel(id);
    for (const call of snapshot.calls) {
      if (!live.has(call.callId)) continue;
      let entry = this.entries.get(call.callId);
      if (!entry) {
        const settings = snapshot.settings.find((s) => s.conversationId === call.conversationId);
        if (!settings) continue;
        const kind = approvalKind(call.name as DesktopToolName);
        const granted = this.grants.get(call.conversationId)?.has(kind ?? "read");
        const permitted =
          kind === "delete"
            ? false
            : kind === null
              ? settings.approval !== "manual"
              : settings.approval === "skip" || granted;
        entry = {
          call,
          pending: permitted ? null : (kind ?? "read"),
          busy: false,
          retries: 0,
          ...(permitted ? { permitted: true } : {}),
          deadline: setTimeout(() => {
            this.cancel(call.callId);
            this.deps.changed();
          }, call.expiresAt - Date.now()),
        };
        this.entries.set(call.callId, entry);
      }
      if (entry.permitted !== undefined) void this.run(entry);
    }
    this.deps.changed();
  }

  pending(conversationId: string): ReadonlyMap<string, PendingKind> {
    return new Map(
      [...this.entries]
        .filter(([, e]) => e.call.conversationId === conversationId && e.pending !== null)
        .map(([id, e]) => [id, e.pending!]),
    );
  }

  attention() {
    return this.snapshot.settings
      .map((s) => ({ ...s, pending: this.pending(s.conversationId).size }))
      .filter((s) => s.pending > 0);
  }

  decide(callId: string, choice: ApprovalChoice) {
    // Expiry is checked synchronously too: a throttled timer cannot revive an
    // old approval when a blanket decision settles several calls together.
    for (const [id, entry] of this.entries) if (entry.call.expiresAt <= Date.now()) this.cancel(id);
    const entry = this.entries.get(callId);
    if (!entry || entry.pending === null) return;
    const kind = entry.pending;
    const blanket = choice === "allow-rest" && kind !== "delete" && kind !== "read";
    if (blanket) {
      const grants = this.grants.get(entry.call.conversationId) ?? new Set<PendingKind>();
      grants.add(kind);
      this.grants.set(entry.call.conversationId, grants);
    }
    for (const candidate of this.entries.values()) {
      if (
        candidate === entry ||
        (blanket &&
          candidate.call.conversationId === entry.call.conversationId &&
          candidate.pending === kind)
      ) {
        candidate.pending = null;
        candidate.permitted = choice !== "deny";
        void this.run(candidate);
      }
    }
    this.deps.changed();
  }

  private live(entry: Entry) {
    return (
      !this.disposed &&
      this.entries.get(entry.call.callId) === entry &&
      entry.call.expiresAt > Date.now()
    );
  }

  private async run(entry: Entry) {
    if (entry.busy || entry.delivered || entry.retry || !this.live(entry)) return;
    entry.busy = true;
    try {
      await this.deps.beforeExecute();
      if (!this.live(entry)) return;
      const token = await this.deps.claim(entry.call);
      if (!this.live(entry)) return;
      if (!token) {
        this.cancel(entry.call.callId);
        this.deps.changed();
        return;
      }
      if (!entry.result) {
        const settings = this.snapshot.settings.find(
          (s) => s.conversationId === entry.call.conversationId,
        );
        if (!settings) return;
        entry.result = entry.permitted
          ? await this.deps.execute(entry.call, settings.network)
          : desktopFailure(
              "You declined that",
              "The user declined this. Do not try it again in another form.",
            );
      }
      if (!this.live(entry)) return;
      const accepted = await this.deps.complete(entry.call, token, entry.result);
      if (!this.live(entry)) return;
      if (!accepted) this.cancel(entry.call.callId);
      else entry.delivered = true;
      this.deps.changed();
    } catch (error) {
      this.deps.error(error);
      if (this.live(entry)) {
        const delay = Math.min(1000 * 2 ** Math.min(entry.retries++, 4), 10_000);
        entry.retry = setTimeout(
          () => {
            entry.retry = undefined;
            void this.run(entry);
          },
          Math.min(delay, Math.max(0, entry.call.expiresAt - Date.now())),
        );
      }
    } finally {
      entry.busy = false;
    }
  }

  private cancel(callId: string) {
    const entry = this.entries.get(callId);
    if (!entry) return;
    clearTimeout(entry.deadline);
    clearTimeout(entry.retry);
    this.entries.delete(callId);
    this.deps.cancel(callId);
  }

  dispose() {
    this.disposed = true;
    for (const [id] of this.entries) this.cancel(id);
    this.grants.clear();
  }
}
