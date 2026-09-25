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
