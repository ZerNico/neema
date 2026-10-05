/**
 * Whether the banner is hidden for a conversation on this machine. Held in
 * module state keyed by the latest foreign stamp: taking over or dismissing
 * remembers the stamp, and the next send from this machine changes the stamp,
 * which is what lets the banner reappear if a third machine later sends.
 */
export const settled = new Map<string, string>();

/**
 * The foreign machine stamp of a work chat, or null when the latest attempt
 * was sent from this machine (or by no machine: browser sends carry none).
 * `attempts` pairs generation display rows with their message, so the latest
 * is decided by message position, never by the rows' own order.
 */
export const foreignMachineStamp = (
  conversationId: string,
  localMachineId: string | null,
  attempts: ReadonlyArray<{
    messageId: string;
    desktopMachine?: { id: string; name: string | null } | null;
  }>,
  messageOrder: ReadonlyArray<string>,
): { id: string; name: string | null } | null => {
  if (localMachineId === null) return null;
  const byMessage = new Map(attempts.map((row) => [row.messageId, row.desktopMachine ?? null]));
  const latest = [...messageOrder]
    .toReversed()
    .map((id) => byMessage.get(id))
    .find((m) => m != null);
  if (!latest || latest.id === localMachineId) return null;
  if (settled.get(conversationId) === latest.id) return null;
  return latest;
};
