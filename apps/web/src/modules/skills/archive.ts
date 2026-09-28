import { zipSync } from "fflate";
import { readZip } from "../attachments/zip.ts";
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

export function readSkillArchive(bytes: Uint8Array): SkillFile[] {
  const files: SkillFile[] = [];
  const invalidFiles: SkillFinding[] = [];
  readZip(bytes, {
    limits: {
      archiveBytes: SKILL_LIMITS.archiveBytes,
      entries: SKILL_LIMITS.files * 2,
      entryBytes: SKILL_LIMITS.fileBytes,
      expandedBytes: SKILL_LIMITS.expandedBytes,
      expansionRatio: SKILL_LIMITS.expansionRatio,
    },
    fail: reject,
    checkName: validateSkillPath,
    // Small compressed chunks also bound the decompressor's transient output allocation.
    chunkBytes: 256,
    accept: (name, content) => {
      if (files.length + invalidFiles.length >= SKILL_LIMITS.files)
        reject(`Package exceeds ${SKILL_LIMITS.files} files.`);
      try {
        files.push({ path: name, content: decodeSkillText(content, name) });
      } catch (error) {
        if (error instanceof SkillPackageError) invalidFiles.push(...error.findings);
        else throw error;
      }
    },
  });
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
