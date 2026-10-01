import { Unzip, UnzipInflate } from "fflate";

/**
 * One bounded ZIP reader for every archive a person hands us: skill imports,
 * PowerPoint packages and the text of Office attachments. The central directory
 * and every local header are checked before anything inflates, and declared
 * sizes are never trusted: actual output is counted as it streams.
 */
export interface ZipLimits {
  readonly archiveBytes: number;
  readonly entries: number;
  /** Largest single entry, as declared and as inflated. */
  readonly entryBytes: number;
  /** All read entries together. */
  readonly expandedBytes: number;
  /** Output bytes allowed per input byte, for one entry and for the archive. */
  readonly expansionRatio: number;
}

export interface ZipReadOptions {
  readonly limits: ZipLimits;
  /**
   * Throws the caller's own error; `name` is the entry concerned, when there is
   * one. `limit` marks an archive too large, by entry count or by size, rather
   * than malformed.
   */
  readonly fail: (message: string, name?: string, limit?: "entries" | "size") => never;
  /** Caller rules for an entry path, run before anything inflates. */
  readonly checkName?: (name: string) => void;
  /** Entries to inflate; the rest are validated but never expanded. */
  readonly wanted?: (name: string) => boolean;
  /** Receives each inflated entry; defaults to collecting them in the returned map. */
  readonly accept?: (name: string, bytes: Uint8Array) => void;
  /** A native CRC-32 where one exists (Node's zlib); the table below serves browsers. */
  readonly crc32?: (bytes: Uint8Array) => number;
  /** Smaller chunks bound the inflater's transient output. */
  readonly chunkBytes?: number;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
const tableCrc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const nameDecoder = new TextDecoder("utf-8", { fatal: true });

type Entry = { readonly size: number; readonly crc: number };

function directory(bytes: Uint8Array, options: ZipReadOptions): Map<string, Entry> {
  const { limits, fail } = options;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50)
    end--;
  if (
    end < Math.max(0, bytes.length - 65557) ||
    end + 22 + view.getUint16(end + 20, true) !== bytes.length
  )
    return fail("Invalid ZIP end record.");
  const count = view.getUint16(end + 10, true);
  const length = view.getUint32(end + 12, true);
  const start = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== count ||
    start + length !== end
  )
    return fail("Split or ZIP64 archives are unsupported.");
  if (count > limits.entries)
    return fail(`A ZIP may have at most ${limits.entries} entries.`, undefined, "entries");
  const entries = new Map<string, Entry>();
  const normalized = new Set<string>();
  const regions: Array<[number, number]> = [];
  let declared = 0;
  let offset = start;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50)
      return fail("Invalid ZIP central directory.");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const packed = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameSize = view.getUint16(offset + 28, true);
    const entryEnd =
      offset +
      46 +
      nameSize +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
    const mode = view.getUint32(offset + 38, true) >>> 16;
    const local = view.getUint32(offset + 42, true);
    if (entryEnd > end || view.getUint16(offset + 34, true) !== 0)
      return fail("Truncated or split ZIP entry.");
    let name: string;
    try {
      name = nameDecoder.decode(bytes.subarray(offset + 46, offset + 46 + nameSize));
    } catch {
      return fail("Invalid ZIP entry name encoding.");
    }
    const folder = name.endsWith("/");
    options.checkName?.(folder ? name.slice(0, -1) : name);
    const key = name.normalize("NFC").toLowerCase();
    if (normalized.has(key)) return fail("Duplicate ZIP entry.", name);
    normalized.add(key);
    if (
      flags & (1 | 64 | 8192) ||
      (method !== 0 && method !== 8) ||
      ((mode & 0xf000) !== 0 && (mode & 0xf000) !== 0x8000 && (mode & 0xf000) !== 0x4000)
    )
      return fail("Encrypted entries, links and special files are unsupported.", name);
    // Entries nobody reads are checked for shape, not size: they never inflate.
    const read = options.wanted?.(name) !== false;
    if (read) declared += size;
    if (
      (folder && size !== 0) ||
      (read &&
        (size > limits.entryBytes ||
          size > Math.max(1, packed) * limits.expansionRatio ||
          declared > limits.expandedBytes ||
          declared > bytes.length * limits.expansionRatio))
    )
      return fail("ZIP entry exceeds the size or expansion limits.", name, "size");
    if (
      local + 30 > end ||
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 6, true) !== flags ||
      view.getUint16(local + 8, true) !== method
    )
      return fail("Inconsistent ZIP local header.", name);
    const localNameSize = view.getUint16(local + 26, true);
    const data = local + 30 + localNameSize + view.getUint16(local + 28, true);
    if (
      localNameSize !== nameSize ||
      data + packed > start ||
      !bytes
        .subarray(local + 30, local + 30 + nameSize)
        .every((byte, at) => byte === bytes[offset + 46 + at])
    )
      return fail("Inconsistent ZIP entry names or data bounds.", name);
    if (
      !(flags & 8) &&
      (view.getUint32(local + 14, true) !== crc ||
        view.getUint32(local + 18, true) !== packed ||
        view.getUint32(local + 22, true) !== size)
    )
      return fail("Inconsistent ZIP local size or checksum.", name);
    regions.push([local, data + packed]);
    entries.set(name, { size, crc });
    offset = entryEnd;
  }
  if (offset !== end) return fail("Invalid ZIP directory length.");
  regions.sort((a, b) => a[0] - b[0]);
  if (regions.some((region, index) => index > 0 && region[0] < regions[index - 1]![1]))
    return fail("Overlapping ZIP entries.");
  return entries;
}

/** Reads the wanted entries of a ZIP, or throws through `fail`. Folders are never returned. */
export function readZip(bytes: Uint8Array, options: ZipReadOptions): Map<string, Uint8Array> {
  const { limits, fail } = options;
  if (bytes.length < 22 || bytes.length > limits.archiveBytes)
    return bytes.length < 22
      ? fail("Invalid ZIP end record.")
      : fail(
          `A ZIP must be at most ${Math.round(limits.archiveBytes / 1024 / 1024)} MiB.`,
          undefined,
          "size",
        );
  const expected = directory(bytes, options);
  const wanted = options.wanted ?? (() => true);
  const crc32 = options.crc32 ?? tableCrc32;
  const output = new Map<string, Uint8Array>();
  const accept = options.accept ?? ((name, data) => output.set(name, data));
  const seen = new Set<string>();
  let expanded = 0;
  // What a callback threw is the caller's own error and must pass through unchanged.
  const thrown: unknown[] = [];
  const guarded =
    <A extends unknown[]>(callback: (...args: A) => void) =>
    (...args: A) => {
      try {
        callback(...args);
      } catch (error) {
        thrown.push(error);
        throw error;
      }
    };
  const unzip = new Unzip(
    guarded((file) => {
      const entry = expected.get(file.name);
      if (!entry || seen.has(file.name)) return fail("Unlisted or repeated ZIP entry.", file.name);
      seen.add(file.name);
      if (!wanted(file.name)) return;
      let size = 0;
      const chunks: Uint8Array[] = [];
      file.ondata = guarded((error, chunk, final) => {
        if (error) return fail("Could not decompress ZIP entry.", file.name);
        size += chunk.length;
        expanded += chunk.length;
        if (
          size > entry.size ||
          expanded > limits.expandedBytes ||
          expanded > bytes.length * limits.expansionRatio
        ) {
          file.terminate();
          return fail("Actual ZIP expansion exceeds the limits.", file.name, "size");
        }
        chunks.push(chunk);
        if (!final) return;
        if (size !== entry.size)
          return fail("ZIP entry size does not match its directory.", file.name);
        if (file.name.endsWith("/")) return;
        const data = new Uint8Array(size);
        let at = 0;
        for (const part of chunks) {
          data.set(part, at);
          at += part.length;
        }
        if (crc32(data) !== entry.crc) return fail("ZIP entry checksum mismatch.", file.name);
        accept(file.name, data);
      });
      file.start();
    }),
  );
  unzip.register(UnzipInflate);
  const step = options.chunkBytes ?? 4096;
  try {
    for (let offset = 0; offset < bytes.length; offset += step)
      unzip.push(bytes.subarray(offset, offset + step), offset + step >= bytes.length);
  } catch {
    if (thrown.length) throw thrown[0];
    return fail("Malformed or unsupported ZIP archive.");
  }
  if (seen.size !== expected.size) return fail("ZIP entries are missing.");
  return output;
}
