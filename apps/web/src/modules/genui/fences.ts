// Finds ```ui fences in assistant Markdown. Server (image resolver, state
// fence) and client (block keys) must agree on which fences exist and in
// which order, so both call this one scanner on the raw message text.

/** Blocks past this count in one message render as source, never as UI. */
export const MAX_UI_BLOCKS = 8;

export interface UiFence {
  /** Position among the message's `ui` fences; the block's identity. */
  readonly ordinal: number;
  /** Offset of the opener line in the scanned text. */
  readonly start: number;
  /** Offset just past the closing fence line, or the text's end when open. */
  readonly end: number;
  /** Offset of the opener's info string, for rewriting it. */
  readonly infoStart: number;
  readonly infoEnd: number;
  readonly code: string;
  readonly closed: boolean;
}

const OPENER = /^( {0,3})(`{3,}|~{3,})(.*)$/;

interface Line {
  readonly text: string;
  readonly start: number;
  /** Offset past the line's newline (or the text's end). */
  readonly next: number;
}

function lines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      out.push({ text: text.slice(start), start, next: text.length });
      break;
    }
    out.push({ text: text.slice(start, nl), start, next: nl + 1 });
    start = nl + 1;
  }
  return out;
}

function isUiInfo(info: string): boolean {
  return /^ui(?:\s|$)/.test(info.trim());
}

/**
 * Every fenced block is tracked so a ```ui inside another fence (an answer
 * explaining the syntax) is not mistaken for a block. Fences nested in list
 * items (4+ spaces) are not recognised; they render as plain code.
 */
export function scanUiFences(text: string): UiFence[] {
  const fences: UiFence[] = [];
  const all = lines(text);
  let i = 0;
  while (i < all.length) {
    const line = all[i]!;
    const open = OPENER.exec(line.text);
    // A backtick fence's info string may not contain backticks (CommonMark).
    if (!open || (open[2]!.startsWith("`") && open[3]!.includes("`"))) {
      i++;
      continue;
    }
    const marker = open[2]!;
    const info = open[3]!;
    const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
    let j = i + 1;
    while (j < all.length && !close.test(all[j]!.text)) j++;
    const closed = j < all.length;
    if (isUiInfo(info)) {
      const bodyStart = line.next;
      const bodyEnd = closed ? all[j]!.start : text.length;
      const infoStart = line.start + open[1]!.length + marker.length;
      fences.push({
        ordinal: fences.length,
        start: line.start,
        end: closed ? all[j]!.next : text.length,
        infoStart,
        infoEnd: line.start + line.text.length,
        // A closed body excludes the newline before the closing fence.
        code: text.slice(bodyStart, Math.max(bodyStart, closed ? bodyEnd - 1 : bodyEnd)),
        closed,
      });
    }
    i = closed ? j + 1 : all.length;
  }
  return fences;
}

/**
 * Rewrites each `ui` opener in a text part to carry its message-wide key
 * (`ui key=3`). `firstOrdinal` is the number of `ui` fences in the message
 * before this part. Runs on the raw part before citation rewriting, so the
 * key never depends on how markers were collapsed.
 */
export function keyUiFences(part: string, firstOrdinal: number): string {
  const fences = scanUiFences(part);
  let out = "";
  let at = 0;
  for (const fence of fences) {
    out += part.slice(at, fence.infoStart) + `ui key=${firstOrdinal + fence.ordinal}`;
    at = fence.infoEnd;
  }
  return out + part.slice(at);
}

/**
 * Applies `transform` to the text between `ui` fences and leaves each block
 * byte-for-byte. Citation rewriting uses it: a `[^5]` in a block's script is
 * code, and collapsing it would also shift the block's source hash.
 */
export function outsideUiFences(text: string, transform: (segment: string) => string): string {
  let out = "";
  let at = 0;
  for (const fence of scanUiFences(text)) {
    out += transform(text.slice(at, fence.start)) + text.slice(fence.start, fence.end);
    at = fence.end;
  }
  return out + transform(text.slice(at));
}

/** Reads the key `keyUiFences` wrote into a fence's info string. */
export function fenceKey(meta: string | undefined): number | null {
  const match = meta ? /(?:^|\s)key=(\d+)(?:\s|$)/.exec(meta) : null;
  if (!match) return null;
  const key = Number(match[1]);
  return key < MAX_UI_BLOCKS ? key : null;
}

/**
 * FNV-1a over UTF-16 code units, as 16 hex digits. Isomorphic and sync: the
 * state fence compares a hash the browser computed with one the server
 * computes from stored content. Not a security boundary. Trailing newlines
 * are ignored: Streamdown hands the renderer the body with one, the scanner
 * without, and a hash that saw the difference would refuse every save.
 */
export function hashSource(raw: string): string {
  const code = raw.replace(/\n+$/, "");
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < code.length; i++) {
    const c = code.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
