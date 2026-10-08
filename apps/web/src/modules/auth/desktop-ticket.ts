/**
 * Pure helpers shared by the server plugin and the browser pages: ticket
 * format, normalisation and the hashes both sides must agree on. Uses only
 * WebCrypto so the same code runs in Node and in the browser.
 */

export const DESKTOP_TICKET_MINUTES = 3;
/**
 * The refusal of a `boundOnly` redemption for a code no shell asked for. The
 * shell then shows the code and waits for a click, rather than an error.
 */
export const UNBOUND_TICKET = "Check that this is your code, then continue.";
export const DESKTOP_SESSION_SECONDS = 90 * 24 * 60 * 60;
/** Prefix the desktop shell appends to its user agent; the server keys on it. */
export const DESKTOP_UA_MARKER = "ChatDesktop/";

/** No 0/O, 1/I/L or U, so a code read aloud or retyped has one spelling. */
export const TICKET_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const TICKET_LENGTH = 20;
const GROUP = 5;

export function generateTicket(): string {
  const out: string[] = [];
  // Rejection sampling keeps every character equally likely; 240 is the
  // largest multiple of the alphabet size below 256.
  const limit = 256 - (256 % TICKET_ALPHABET.length);
  const bytes = new Uint8Array(TICKET_LENGTH * 2);
  while (out.length < TICKET_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b >= limit) continue;
      out.push(TICKET_ALPHABET[b % TICKET_ALPHABET.length]!);
      if (out.length === TICKET_LENGTH) break;
    }
  }
  return out.join("");
}

export function formatTicket(ticket: string): string {
  const groups: string[] = [];
  for (let i = 0; i < ticket.length; i += GROUP) groups.push(ticket.slice(i, i + GROUP));
  return groups.join("-");
}

/** Upper-cases and drops separators; does not validate. */
export function normaliseTicket(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isTicketShaped(normalised: string): boolean {
  if (normalised.length !== TICKET_LENGTH) return false;
  for (const c of normalised) if (!TICKET_ALPHABET.includes(c)) return false;
  return true;
}

export function hasDesktopMarker(userAgent: string | null | undefined): boolean {
  return typeof userAgent === "string" && userAgent.includes(DESKTOP_UA_MARKER);
}

const encoder = new TextEncoder();

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** Tickets are stored hashed so a read of the verification table yields nothing usable. */
export async function hashTicket(normalised: string): Promise<string> {
  return hex(await sha256(normalised));
}

export function createVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** RFC 7636 S256: the challenge the desktop sends when it opens the browser. */
export async function challengeOf(verifier: string): Promise<string> {
  return base64url(await sha256(verifier));
}
