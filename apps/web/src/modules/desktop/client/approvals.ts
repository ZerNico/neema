import { useCallback, useMemo, useRef, useState } from "react";
import { type ApprovalKind, approvalKind } from "../tool-schema.ts";

/**
 * Consent for the calls that change the machine.
 *
 * Reads are not asked about: the folder was handed over deliberately and a read
 * inside it is what handing it over meant. Edits, deletes and commands are
 * tracked apart, so allowing a refactor to keep editing never quietly allows a
 * shell, and a delete is asked about every time.
 *
 * The decision is held here rather than on the server because the page is what
 * executes the call: nothing reaches the machine until this resolves, so a
 * refusal is enforced by the work simply not happening.
 */

export { approvalKind, type ApprovalKind };

export type ApprovalChoice = "allow" | "deny" | "allow-rest";

/**
 * How much the reader wants to be asked, per conversation.
 *
 * - `manual`: every call, reads included.
 * - `auto`: changes and commands; reads run. The default.
 * - `skip`: nothing.
 *
 * A delete is asked about at every level. It is the one change nothing can
 * undo, and the same rule the desktop assistants this mirrors keep.
 */
export type PermissionLevel = "manual" | "auto" | "skip";

/** What a card may be asking about: a change kind, or a read under `manual`. */
export type PendingKind = ApprovalKind | "read";

export const PERMISSION_LEVELS: ReadonlyArray<{
  value: PermissionLevel;
  label: string;
  description: string;
}> = [
  { value: "manual", label: "Ask each time", description: "Every read, change and command." },
  { value: "auto", label: "Ask before changes", description: "Reads run on their own." },
  { value: "skip", label: "Don’t ask", description: "Everything runs. Deletes still ask." },
];

const KEY_PREFIX = "desktop.permissions.";

const readLevel = (conversationId: string): PermissionLevel => {
  if (typeof window === "undefined") return "auto";
  const stored = window.localStorage.getItem(KEY_PREFIX + conversationId);
  return stored === "manual" || stored === "skip" ? stored : "auto";
};

export interface DesktopApprovals {
  /** What each waiting call is asking permission to do, by call id. */
  readonly pending: ReadonlyMap<string, PendingKind>;
  /** Kinds already allowed for the rest of this conversation. */
  readonly blanket: Readonly<Record<ApprovalKind, boolean>>;
  readonly level: PermissionLevel;
  readonly setLevel: (level: PermissionLevel) => void;
  /**
   * Resolves once a decision is made, immediately when the level or a blanket
   * grant already answers it. `kind` null is a read, asked about only under
   * `manual`.
   */
  readonly ask: (callId: string, kind: ApprovalKind | null) => Promise<boolean>;
  readonly decide: (callId: string, choice: ApprovalChoice) => void;
  /** Abandons a request whose call is no longer live, without deciding it. */
  readonly forget: (callId: string) => void;
}

export const useDesktopApprovals = (conversationId: string): DesktopApprovals => {
  const [pending, setPending] = useState<ReadonlyMap<string, PendingKind>>(new Map());
  const [blanket, setBlanket] = useState<Record<ApprovalKind, boolean>>({
    edit: false,
    delete: false,
    command: false,
  });
  // Remembered per conversation on this machine, beside the folder itself:
  // the server has no say in what this computer asks its owner.
  const [level, setLevelState] = useState<PermissionLevel>(() => readLevel(conversationId));
  const levelRef = useRef(level);
  const setLevel = useCallback(
    (next: PermissionLevel) => {
      levelRef.current = next;
      setLevelState(next);
      window.localStorage.setItem(KEY_PREFIX + conversationId, next);
    },
    [conversationId],
  );
  // Resolvers cannot live in state: deciding must not depend on a render
  // having happened, and a re-render must not lose the parked promise.
  const waiting = useRef(new Map<string, (allowed: boolean) => void>());
  const granted = useRef(blanket);

  const settle = useCallback((callId: string, allowed: boolean) => {
    waiting.current.get(callId)?.(allowed);
    waiting.current.delete(callId);
    setPending((current) => {
      if (!current.has(callId)) return current;
      const next = new Map(current);
      next.delete(callId);
      return next;
    });
  }, []);

  const ask = useCallback(
    (callId: string, kind: ApprovalKind | null) =>
      new Promise<boolean>((resolve) => {
        const current = levelRef.current;
        const answered =
          kind === null
            ? current !== "manual"
            : kind === "delete"
              ? false
              : current === "skip" || granted.current[kind];
        if (answered) {
          resolve(true);
          return;
        }
        waiting.current.set(callId, resolve);
        setPending((pendingNow) => new Map(pendingNow).set(callId, kind ?? "read"));
      }),
    [],
  );

  const decide = useCallback(
    (callId: string, choice: ApprovalChoice) => {
      if (choice === "allow-rest") {
        const kind = pending.get(callId);
        // A delete is asked about every time, whatever was allowed before.
        if (kind && kind !== "delete" && kind !== "read") {
          granted.current = { ...granted.current, [kind]: true };
          setBlanket(granted.current);
          // Everything else already waiting on that kind is answered too, so a
          // queued call does not ask again for what was just allowed.
          for (const [id, waitingKind] of pending) if (waitingKind === kind) settle(id, true);
          return;
        }
      }
      settle(callId, choice !== "deny");
    },
    [pending, settle],
  );

  const forget = useCallback((callId: string) => settle(callId, false), [settle]);

  return useMemo(
    () => ({ pending, blanket, level, setLevel, ask, decide, forget }),
    [pending, blanket, level, setLevel, ask, decide, forget],
  );
};
