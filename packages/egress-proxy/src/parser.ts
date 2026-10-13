export interface RequestHead {
  readonly method: string;
  readonly target: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly early: Buffer;
}

type Parsed = { request: RequestHead } | { error: 400 | 431 } | undefined;
const headerLimit = 16 * 1024;

/** True when `text` holds an ASCII control character. Tab passes only when `tab` allows it. */
function hasControl(text: string, tab: boolean) {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if ((code < 0x20 && !(tab && code === 0x09)) || code === 0x7f) return true;
  }
  return false;
}

export class RequestParser {
  private readonly bytes = Buffer.allocUnsafe(headerLimit);
  private length = 0;

  feed(chunk: Buffer): Parsed {
    const previous = this.length;
    const copied = chunk.copy(this.bytes, previous, 0, headerLimit - previous);
    this.length += copied;
    const bytes = this.bytes.subarray(0, this.length);
    // Only the last three old bytes can begin a terminator split across reads.
    const boundary = bytes.indexOf("\r\n\r\n", Math.max(0, previous - 3));
    if (boundary < 0) return this.length === headerLimit ? { error: 431 } : undefined;
    const [line = "", ...lines] = bytes.subarray(0, boundary).toString("latin1").split("\r\n");
    const [whole, method, target] =
      /^([!#$%&'*+.^_`|~0-9A-Za-z-]+) ([^ ]+) HTTP\/1\.[01]$/.exec(line) ?? [];
    if (whole !== line || method === undefined || target === undefined || hasControl(target, false))
      return { error: 400 };
    const headers: Array<readonly [string, string]> = [];
    for (const header of lines) {
      const colon = header.indexOf(":");
      const name = header.slice(0, colon);
      const value = header.slice(colon + 1);
      if (colon < 1 || /[^!#$%&'*+.^_`|~0-9A-Za-z-]/.test(name) || hasControl(value, true))
        return { error: 400 };
      let start = 0;
      let end = value.length;
      while (start < end && (value[start] === " " || value[start] === "\t")) start++;
      while (end > start && (value[end - 1] === " " || value[end - 1] === "\t")) end--;
      headers.push([name.toLowerCase(), value.slice(start, end)]);
    }
    const lengths = headers.filter(([name]) => name === "content-length");
    const encodings = headers.filter(([name]) => name === "transfer-encoding");
    if (
      lengths.length > 1 ||
      lengths.some(([, value]) => !/^(0|[1-9][0-9]*)$/.test(value)) ||
      (encodings.length > 0 && lengths.length > 0)
    )
      return { error: 400 };
    // CONNECT bytes are opaque, not an HTTP request body with a second framing scheme.
    if (
      method === "CONNECT" &&
      (encodings.length > 0 || lengths.some(([, value]) => value !== "0"))
    )
      return { error: 400 };
    const early = Buffer.concat([bytes.subarray(boundary + 4), chunk.subarray(copied)]);
    return { request: { method, target, headers, early } };
  }
}
