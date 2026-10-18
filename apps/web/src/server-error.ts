/**
 * The body contract between `reportUnexpectedFailures` and the client. A
 * refused call keeps only its response's text (`refusals.ts`), so an
 * unexpected failure is recognised by this exact shape: a fixed friendly line,
 * then the reference the server logged it under.
 */
export const UNEXPECTED_FAILURE = "Something went wrong on our side.";
const REFERENCE_PREFIX = "Reference: ";

// No 0/O or 1/I/L, so a reference read aloud or retyped still matches the log.
const REFERENCE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export const newErrorReference = (random: (length: number) => Uint8Array) =>
  Array.from(random(6), (byte) => REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length]).join("");

export const unexpectedFailureBody = (reference: string) =>
  `${UNEXPECTED_FAILURE}\n${REFERENCE_PREFIX}${reference}`;

export interface ServerError {
  /** What the server said, or null when it said nothing a person can use. */
  reason: string | null;
  /** Set only for an unexpected failure the server logged. */
  reference: string | null;
  /** The raw text, for a report. */
  raw: string;
}

export function readServerError(error: unknown): ServerError {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const [first = "", second = ""] = raw.split("\n");
  if (first === UNEXPECTED_FAILURE && second.startsWith(REFERENCE_PREFIX))
    return { reason: null, reference: second.slice(REFERENCE_PREFIX.length).trim(), raw };
  // A refused call arrives as a plain Error (`refusals.ts`); a TypeError
  // or any other subclass is the network or a bug in this page, not a reason.
  const fromServer =
    typeof error === "string" || (error instanceof Error && error.name === "Error");
  const reason = fromServer ? raw.trim() : "";
  // Bare status words tell a person nothing.
  const useless =
    !reason ||
    /^(Unauthorized|Not found|Forbidden|Failed to fetch|Load failed|NetworkError)/i.test(reason);
  return { reason: useless ? null : reason, reference: null, raw };
}
