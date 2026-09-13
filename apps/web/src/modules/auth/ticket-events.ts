/**
 * How a tab showing a desktop code learns its code was used. `useSync` turns
 * the `desktop.session.created` sync event into a window event, so the code
 * component needs no query client and no knowledge of the SSE feed.
 */
export const DESKTOP_SESSION_CREATED_EVENT = "chat:desktop-session-created";

export interface DesktopSessionCreatedDetail {
  ticketId: string;
}

export function announceTicketRedeemed(ticketId: string): void {
  window.dispatchEvent(
    new CustomEvent<DesktopSessionCreatedDetail>(DESKTOP_SESSION_CREATED_EVENT, {
      detail: { ticketId },
    }),
  );
}

/** Calls back when this ticket in particular is redeemed; returns the unsubscribe. */
export function subscribeTicketRedeemed(ticketId: string, onRedeemed: () => void): () => void {
  const listener = (event: Event) => {
    if ((event as CustomEvent<DesktopSessionCreatedDetail>).detail?.ticketId === ticketId)
      onRedeemed();
  };
  window.addEventListener(DESKTOP_SESSION_CREATED_EVENT, listener);
  return () => window.removeEventListener(DESKTOP_SESSION_CREATED_EVENT, listener);
}
