/** One top-level string field of an object that may still be arriving. */
export interface PartialField {
  value: string;
  /** False while the closing quote has not arrived yet. */
  complete: boolean;
}

const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * The top-level string fields of a JSON object read so far, as a model streams
 * a tool call's arguments. A value still being written comes back incomplete,
 * cut before any escape that has not fully arrived; other kinds of value are
 * skipped. Stops quietly at anything it cannot read, since the complete call
 * is decoded properly later.
 */
export function readPartialObject(raw: string): Map<string, PartialField> {
  const fields = new Map<string, PartialField>();
  let at = 0;
  const skipSpace = () => {
    while (at < raw.length && /\s/.test(raw[at]!)) at++;
  };
  const readString = (): PartialField | null => {
    if (raw[at] !== '"') return null;
    at++;
    let value = "";
    while (at < raw.length) {
      const char = raw[at]!;
      if (char === '"') {
        at++;
        return { value, complete: true };
      }
      if (char !== "\\") {
        value += char;
        at++;
        continue;
      }
      const code = raw[at + 1];
      if (code === undefined) return { value, complete: false };
      if (code === "u") {
        const hex = raw.slice(at + 2, at + 6);
        if (hex.length < 4) return { value, complete: false };
        value += String.fromCharCode(Number.parseInt(hex, 16));
        at += 6;
        continue;
      }
      value += ESCAPES[code] ?? code;
      at += 2;
    }
    return { value, complete: false };
  };
  /** Past a non-string value, respecting nesting and strings inside it. */
  const skipValue = () => {
    let depth = 0;
    while (at < raw.length) {
      const char = raw[at]!;
      if (char === '"') {
        if (!readString()?.complete) return false;
        continue;
      }
      if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") {
        if (depth === 0) return true;
        depth--;
      } else if (char === "," && depth === 0) return true;
      at++;
    }
    return false;
  };

  skipSpace();
  if (raw[at] !== "{") return fields;
  at++;
  while (at < raw.length) {
    skipSpace();
    if (raw[at] === ",") {
      at++;
      continue;
    }
    if (raw[at] === "}") break;
    const key = readString();
    if (!key?.complete) break;
    skipSpace();
    if (raw[at] !== ":") break;
    at++;
    skipSpace();
    if (raw[at] === '"') {
      const value = readString()!;
      fields.set(key.value, value);
      if (!value.complete) break;
    } else if (!skipValue()) break;
  }
  return fields;
}

/**
 * The elements of one array field of an object that may still be arriving:
 * those already complete, parsed, and the text of the one being written.
 * Nested arrays and strings are followed, so a bracket inside text never
 * ends an element early.
 */
export function readPartialArray(
  raw: string,
  key: string,
): { complete: unknown[]; partial: string | null } {
  const found = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(raw);
  if (!found) return { complete: [], partial: null };
  const complete: unknown[] = [];
  let at = found.index + found[0].length;
  let start = -1;
  let depth = 0;
  let inString = false;
  for (; at < raw.length; at++) {
    const char = raw[at]!;
    if (inString) {
      if (char === "\\") at++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      if (depth === 0 && start === -1) start = at;
      continue;
    }
    if (char === "[" || char === "{") {
      if (depth === 0) start = at;
      depth++;
    } else if (char === "]" || char === "}") {
      if (depth === 0) {
        // The array ends; a bare value before it is its last element.
        if (start !== -1)
          try {
            complete.push(JSON.parse(raw.slice(start, at)));
          } catch {
            return { complete, partial: null };
          }
        return { complete, partial: null };
      }
      depth--;
      if (depth === 0) {
        try {
          complete.push(JSON.parse(raw.slice(start, at + 1)));
        } catch {
          return { complete, partial: null };
        }
        start = -1;
      }
    } else if (depth === 0 && start === -1 && /[-\d\w]/.test(char)) start = at;
    else if (depth === 0 && char === "," && start !== -1) {
      // A bare value (a number, true, null) ends at its comma.
      try {
        complete.push(JSON.parse(raw.slice(start, at)));
      } catch {
        return { complete, partial: null };
      }
      start = -1;
    }
  }
  return { complete, partial: start === -1 ? null : raw.slice(start) };
}
