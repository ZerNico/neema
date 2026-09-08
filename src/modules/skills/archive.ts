import { Unzip, UnzipInflate, zipSync } from "fflate";
import {
  decodeSkillText,
  SKILL_LIMITS,
  SkillPackageError,
  validateSkillPackage,
  validateSkillPath,
  type SkillFile,
  type SkillFinding,
} from "./package.ts";

const reject = (message: string, path = "archive.zip"): never => {
  throw new SkillPackageError([{ severity: "error", path, message }]);
};

/** Inspect central AND local headers before decompression. Never trust declared output sizes. */
function inspectArchive(bytes: Uint8Array): Map<string, { size: number; crc: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  let found = false;
  for (; end >= Math.max(0, bytes.length - 65557); end--)
    if (view.getUint32(end, true) === 0x06054b50) {
      found = true;
      break;
    }
  if (!found || end + 22 + view.getUint16(end + 20, true) !== bytes.length)
    return reject("Invalid ZIP end record.");
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== count ||
    count > SKILL_LIMITS.files * 2 ||
    offset + directorySize !== end
  )
    return reject("Split, ZIP64 or oversized archives are unsupported.");
  const names = new Map<string, { size: number; crc: number }>();
  const normalized = new Set<string>();
  const regions: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50)
      return reject("Invalid ZIP directory.");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const size = view.getUint32(offset + 20, true);
    const crc = view.getUint32(offset + 16, true);
    if (view.getUint16(offset + 34, true) !== 0) return reject("Split archives are unsupported.");
    const expanded = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const mode = view.getUint32(offset + 38, true) >>> 16;
    const local = view.getUint32(offset + 42, true);
    if (offset + 46 + nameLength + extraLength + commentLength > end)
      return reject("Truncated ZIP entry.");
    const name = decodeSkillText(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
      "archive.zip",
    );
    const directory = name.endsWith("/");
    validateSkillPath(directory ? name.slice(0, -1) : name);
    const key = name.normalize("NFC").toLowerCase();
    if (normalized.has(key)) return reject("Duplicate ZIP entry.", name);
    normalized.add(key);
    if (
      flags & (1 | 64 | 8192) ||
      (method !== 0 && method !== 8) ||
      ((mode & 0xf000) !== 0 && (mode & 0xf000) !== 0x8000 && (mode & 0xf000) !== 0x4000)
    )
      return reject("Encrypted entries, links and special files are unsupported.", name);
    if (
      expanded > SKILL_LIMITS.fileBytes ||
      expanded > Math.max(1, size) * SKILL_LIMITS.expansionRatio ||
      (directory && expanded !== 0)
    )
      return reject("Entry exceeds size or expansion limits.", name);
    if (
      local + 30 > end ||
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 6, true) !== flags ||
      view.getUint16(local + 8, true) !== method
    )
      return reject("Inconsistent ZIP headers.", name);
    const localNameLength = view.getUint16(local + 26, true);
    const dataStart = local + 30 + localNameLength + view.getUint16(local + 28, true);
    if (
      decodeSkillText(bytes.subarray(local + 30, local + 30 + localNameLength), name) !== name ||
      dataStart + size > view.getUint32(end + 16, true)
    )
      return reject("Inconsistent ZIP paths or data bounds.", name);
    regions.push([local, dataStart + size]);
    if (
      !(flags & 8) &&
      (view.getUint32(local + 14, true) !== crc ||
        view.getUint32(local + 18, true) !== size ||
        view.getUint32(local + 22, true) !== expanded)
    )
      return reject("Inconsistent local size or checksum.", name);
    names.set(name, { size: expanded, crc });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== end) return reject("Invalid ZIP directory length.");
  regions.sort((a, b) => a[0] - b[0]);
  if (regions.some((region, index) => index > 0 && region[0] < regions[index - 1]![1]))
    return reject("Overlapping ZIP entries.");
  return names;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
export function readSkillArchive(bytes: Uint8Array): SkillFile[] {
  if (bytes.length < 22 || bytes.length > SKILL_LIMITS.archiveBytes)
    return reject("ZIP input must be at most 5 MiB.");
  const expected = inspectArchive(bytes);
  const files: SkillFile[] = [];
  const invalidFiles: SkillFinding[] = [];
  const encountered = new Set<string>();
  let total = 0;
  const unzip = new Unzip((file) => {
    if (!expected.has(file.name) || encountered.has(file.name))
      return reject("Unlisted or repeated local ZIP entry.", file.name);
    encountered.add(file.name);
    let size = 0;
    const chunks: Uint8Array[] = [];
    file.ondata = (error, chunk, final) => {
      if (error) return reject("Could not decompress entry.", file.name);
      size += chunk.length;
      total += chunk.length;
      if (
        size > SKILL_LIMITS.fileBytes ||
        total > SKILL_LIMITS.expandedBytes ||
        total > bytes.length * SKILL_LIMITS.expansionRatio
      ) {
        file.terminate();
        return reject("Actual expanded bytes exceed package limits.", file.name);
      }
      chunks.push(chunk);
      if (final) {
        if (size !== expected.get(file.name)?.size)
          return reject("Expanded entry size does not match its manifest.", file.name);
        if (file.name.endsWith("/")) return;
        if (files.length + invalidFiles.length >= SKILL_LIMITS.files)
          return reject("Package exceeds 100 files.");
        const output = new Uint8Array(size);
        let offset = 0;
        for (const part of chunks) {
          output.set(part, offset);
          offset += part.length;
        }
        if (crc32(output) !== expected.get(file.name)?.crc)
          return reject("Entry checksum does not match its bytes.", file.name);
        try {
          files.push({ path: file.name, content: decodeSkillText(output, file.name) });
        } catch (error) {
          if (error instanceof SkillPackageError) invalidFiles.push(...error.findings);
          else throw error;
        }
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    // Small compressed chunks also bound the decompressor's transient output allocation.
    for (let offset = 0; offset < bytes.length; offset += 256)
      unzip.push(bytes.subarray(offset, offset + 256), offset + 256 >= bytes.length);
  } catch (error) {
    if (error instanceof SkillPackageError) throw error;
    return reject("Malformed or unsupported ZIP archive.");
  }
  if (encountered.size !== expected.size) return reject("Missing ZIP entries.");
  if (invalidFiles.length) throw new SkillPackageError(invalidFiles);
  return files;
}

export function skillPackageRoots(files: readonly SkillFile[]): string[] {
  return files
    .filter((file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"))
    .map((file) => file.path.slice(0, -"SKILL.md".length));
}

export function selectSkillPackage(files: readonly SkillFile[], root: string) {
  if (!skillPackageRoots(files).includes(root))
    return reject("Select an existing SKILL.md package root.");
  return validateSkillPackage(
    files
      .filter((file) => file.path.startsWith(root))
      .map((file) => ({ ...file, path: file.path.slice(root.length) })),
  );
}

export function exportSkillArchive(files: readonly SkillFile[]): Uint8Array {
  const validated = validateSkillPackage(files);
  const entries = Object.create(null) as Record<string, Uint8Array>;
  for (const file of validated.files) entries[file.path] = new TextEncoder().encode(file.content);
  return zipSync(entries, { level: 6 });
}
