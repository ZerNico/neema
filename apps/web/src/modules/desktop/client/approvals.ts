import { useCallback, useMemo, useRef, useState } from "react";
import { changesTheMachine, type DesktopToolName } from "../tool-schema.ts";

/**
 * Consent for the calls that change the machine.
 *
 * Reads are not asked about: the folder was handed over deliberately and a read
 * inside it is what handing it over meant. Writes and commands are tracked
 * apart, so allowing a refactor to keep editing never quietly allows a shell.
 *
 * The decision is held here rather than on the server because the page is what
 * executes the call: nothing reaches the machine until this resolves, so a
 * refusal is enforced by the work simply not happening.
 */

export type ApprovalKind = "write" | "command";

export const approvalKind = (name: DesktopToolName): ApprovalKind | null =>
  changesTheMachine(name) ? (name === "run_command" ? "command" : "write") : null;

export type ApprovalChoice = "allow" | "deny" | "allow-rest";

export interface DesktopApprovals {
  /** What each waiting call is asking permission to do, by call id. */
  readonly pending: ReadonlyMap<string, ApprovalKind>;
  /** Kinds already allowed for the rest of this conversation. */
  readonly blanket: Readonly<Record<ApprovalKind, boolean>>;
  /** Resolves once a decision is made, immediately under a blanket grant. */
  readonly ask: (callId: string, kind: ApprovalKind) => Promise<boolean>;
  readonly decide: (callId: string, choice: ApprovalChoice) => void;
  /** Abandons a request whose call is no longer live, without deciding it. */
  readonly forget: (callId: string) => void;
}

export const useDesktopApprovals = (): DesktopApprovals => {
  const [pending, setPending] = useState<ReadonlyMap<string, ApprovalKind>>(new Map());
  const [blanket, setBlanket] = useState<Record<ApprovalKind, boolean>>({
    write: false,
    command: false,
  });
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
    (callId: string, kind: ApprovalKind) =>
      new Promise<boolean>((resolve) => {
        if (granted.current[kind]) {
          resolve(true);
          return;
        }
        waiting.current.set(callId, resolve);
        setPending((current) => new Map(current).set(callId, kind));
      }),
    [],
  );

  const decide = useCallback(
    (callId: string, choice: ApprovalChoice) => {
      if (choice === "allow-rest") {
        const kind = pending.get(callId);
        if (kind) {
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
    () => ({ pending, blanket, ask, decide, forget }),
    [pending, blanket, ask, decide, forget],
  );
};
