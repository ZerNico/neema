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
import {
  allowsBlanket,
  firstDecision,
  type ApprovalChoice,
  type PendingKind,
} from "./approvals.ts";

export interface WorkSnapshot {
  attempts: ExternalOwner[];
  calls: ExternalOperation[];
  settings: {
    conversationId: string;
    title: string | null;
    approval: PermissionLevel;
  }[];
}
export interface WorkDependencies {
  claim(call: ExternalOperation): Promise<string | null>;
  /**
   * Runs the call locally; `remainingMs` is what is left of the server's
   * deadline. `askSite` asks the person, while the call runs, about a site it
   * was led to, such as a link a click followed.
   */
  execute(
    call: ExternalOperation,
    remainingMs: number,
    askSite: (url: string) => Promise<boolean>,
  ): Promise<DesktopToolResult>;
  complete(call: ExternalOperation, token: string, result: DesktopToolResult): Promise<boolean>;
  cancel(callId: string): void;
  changed(): void;
  error(error: unknown): void;
  /** Whether a site call's address is already allowed for its chat. Absent: never. */
  siteAllowed?(call: ExternalOperation): Promise<boolean>;
  /** Remembers a call's site for its chat, or for every chat on this desktop. */
  allowSite?(call: ExternalOperation, scope: "chat" | "always"): Promise<void>;
}
interface Entry {
  call: ExternalOperation;
  pending: PendingKind | null;
  permitted?: boolean;
  /** A site call waiting to learn whether its site is already allowed. */
  checking?: boolean;
  /** A running call asking about a site it was led to; answered by `decide`. */
  asking?: { url: string; answer: (allowed: boolean) => void } | undefined;
  result?: DesktopToolResult;
  busy: boolean;
  delivered?: boolean;
  retries: number;
  retry?: ReturnType<typeof setTimeout> | undefined;
  deadline: ReturnType<typeof setTimeout>;
}

/**
 * One instance per authenticated document, not per chat route. IPC owns replay
 * across document reloads; this controller owns consent and result delivery.
 */
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
        const kind = approvalKind(call.name as DesktopToolName, call.args);
        const decision = firstDecision(
          kind,
          settings.approval,
          this.grants.get(call.conversationId)?.has(kind ?? "read") ?? false,
          call.meta?.preauthorized === true,
        );
        const permitted = decision === "run";
        const checking = decision === "check-site";
        entry = {
          call,
          pending: decision === "ask" ? (kind ?? "read") : null,
          busy: false,
          retries: 0,
          ...(permitted ? { permitted: true } : {}),
          ...(checking ? { checking: true } : {}),
          deadline: setTimeout(() => {
            this.cancel(call.callId);
            this.deps.changed();
          }, call.expiresAt - Date.now()),
        };
        this.entries.set(call.callId, entry);
        if (checking) void this.checkSite(entry);
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

  /**
   * A waiting call's arguments as the model sent them. Held in memory only, so
   * an approval card can show what is never stored, like text to be typed.
   */
  args(callId: string): Readonly<Record<string, unknown>> | null {
    const entry = this.entries.get(callId);
    if (!entry || entry.pending === null) return null;
    return entry.asking ? { ...entry.call.args, url: entry.asking.url } : entry.call.args;
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
    if (entry.asking) return this.answerSite(entry, choice);
    const kind = entry.pending;
    const blanket = choice === "allow-rest" && allowsBlanket(kind);
    if (kind === "site" && (choice === "allow-site" || choice === "allow-always")) {
      // Once remembered, other calls of this chat waiting on a site ask again;
      // the ones for the same site now find it allowed.
      const scope = choice === "allow-always" ? "always" : "chat";
      void (this.deps.allowSite?.(entry.call, scope) ?? Promise.resolve()).then(() => {
        for (const other of this.entries.values()) {
          if (
            other === entry ||
            other.pending !== "site" ||
            other.asking !== undefined ||
            other.call.conversationId !== entry.call.conversationId
          )
            continue;
          other.pending = null;
          other.checking = true;
          void this.checkSite(other);
        }
        this.deps.changed();
      }, this.deps.error);
    }
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

  private async checkSite(entry: Entry) {
    const allowed = await (this.deps.siteAllowed?.(entry.call) ?? Promise.resolve(false)).catch(
      () => false,
    );
    if (!this.live(entry) || !entry.checking) return;
    entry.checking = false;
    if (allowed) {
      entry.permitted = true;
      void this.run(entry);
    } else entry.pending = "site";
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
      const token = await this.deps.claim(entry.call);
      if (!this.live(entry)) return;
      if (!token) {
        this.cancel(entry.call.callId);
        this.deps.changed();
        return;
      }
      if (!entry.result) {
        entry.result = entry.permitted
          ? await this.deps.execute(entry.call, entry.call.expiresAt - Date.now(), (url) =>
              this.askSite(entry, url),
            )
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

  private askSite(entry: Entry, url: string) {
    return new Promise<boolean>((answer) => {
      if (!this.live(entry)) return answer(false);
      entry.asking = { url, answer };
      entry.pending = "site";
      this.deps.changed();
    });
  }

  /**
   * Answers a running call's question about a site. Nothing new runs: the call
   * is still running and goes on with the answer.
   */
  private answerSite(entry: Entry, choice: ApprovalChoice) {
    const asking = entry.asking;
    if (!asking) return;
    entry.asking = undefined;
    entry.pending = null;
    if (choice === "allow-site" || choice === "allow-always") {
      const call = { ...entry.call, args: { ...entry.call.args, url: asking.url } };
      void (
        this.deps.allowSite?.(call, choice === "allow-always" ? "always" : "chat") ??
        Promise.resolve()
      )
        .catch(this.deps.error)
        .finally(() => asking.answer(true));
    } else asking.answer(choice === "allow");
    this.deps.changed();
  }

  private cancel(callId: string) {
    const entry = this.entries.get(callId);
    if (!entry) return;
    entry.asking?.answer(false);
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
