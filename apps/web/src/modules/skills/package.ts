import { parseDocument } from "yaml";
import { LIMITS } from "@chat/desktop-rpc/schema";
import { classifyFile } from "../attachments/server/validation.ts";

export const SKILL_LIMITS = {
  archiveBytes: 50 * 1024 * 1024,
  expandedBytes: 50 * 1024 * 1024,
  fileBytes: 256 * 1024,
  /** A template or font; the same bound as any other stored file. */
  binaryFileBytes: LIMITS.binaryBytes,
  rootBytes: 64 * 1024,
  files: 100,
  depth: 10,
  expansionRatio: 100,
  catalogue: 20,
  loaded: 5,
  operations: 32,
  readChars: 8000,
  concurrentReads: 2,
} as const;

export interface SkillTextFile {
  path: string;
  content: string;
}
/**
 * A file that is not skill text: a template, image or font. Its bytes never
 * travel as JSON; they arrive as `bytes` (an import), an `uploadId` (the
 * editor), or stay where a `sha256` already names them.
 */
export interface SkillBinaryFile {
  path: string;
  binary: {
    size: number;
    mediaType: string;
    sha256?: string | undefined;
    uploadId?: string | undefined;
  };
  bytes?: Uint8Array;
}
export type SkillFile = SkillTextFile | SkillBinaryFile;

export const isBinarySkillFile = (file: SkillFile): file is SkillBinaryFile => "binary" in file;

/** A file as it may cross to the browser: a binary keeps its description, not its bytes. */
export const withoutBytes = (file: SkillFile): SkillFile =>
  isBinarySkillFile(file) ? { path: file.path, binary: { ...file.binary } } : file;
export interface SkillFinding {
  severity: "error" | "warning";
  path: string;
  message: string;
  line?: number;
}
export interface SkillMetadata {
  name: string;
  description: string;
  manualOnly: boolean;
}
export interface ValidatedSkillPackage {
  files: SkillFile[];
  metadata: SkillMetadata;
  findings: SkillFinding[];
}
export class SkillPackageError extends Error {
  constructor(readonly findings: SkillFinding[]) {
    super(findings.map((finding) => `${finding.path}: ${finding.message}`).join("\n"));
    this.name = "SkillPackageError";
  }
}

/** C0 controls and DEL; text may keep tab, newline, form feed and carriage return. */
const hasControl = (text: string, allowWhitespace: boolean) => {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x7f) return true;
    if (code >= 0x20) continue;
    if (!allowWhitespace || (code !== 9 && code !== 10 && code !== 12 && code !== 13)) return true;
  }
  return false;
};

/** No filesystem extraction; all readers use these exact, canonical relative paths. */
export function validateSkillPath(path: string): string {
  if (
    !path ||
    path.length > 240 ||
    path !== path.normalize("NFC") ||
    path.includes("\\") ||
    path.includes(":") ||
    hasControl(path, false) ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/u.test(part)) ||
    path.split("/").length > SKILL_LIMITS.depth
  ) {
    throw new SkillPackageError([
      { severity: "error", path, message: "Use a safe relative file path (maximum depth 10)." },
    ]);
  }
  return path;
}

export function decodeSkillText(bytes: Uint8Array, path: string): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (hasControl(text, true)) throw new Error("binary");
    return text;
  } catch {
    throw new SkillPackageError([
      {
        severity: "error",
        path,
        message: "This file must be UTF-8 text without control characters.",
      },
    ]);
  }
}

/**
 * Text when it reads as skill text within the text limit, so read_skill_file
 * can show it; anything else is kept as a binary asset for tools to open.
 */
export function classifySkillFile(path: string, bytes: Uint8Array): SkillFile {
  if (bytes.length <= SKILL_LIMITS.fileBytes)
    try {
      return { path, content: decodeSkillText(bytes, path) };
    } catch (cause) {
      if (!(cause instanceof SkillPackageError)) throw cause;
    }
  const name = path.slice(path.lastIndexOf("/") + 1);
  return {
    path,
    binary: { size: bytes.length, mediaType: classifyFile(name, "", bytes).mediaType },
    bytes,
  };
}

export function validateSkillPackage(input: readonly SkillFile[]): ValidatedSkillPackage {
  const findings: SkillFinding[] = [];
  const error = (path: string, message: string, line?: number) =>
    findings.push({ severity: "error", path, message, ...(line ? { line } : {}) });
  if (input.length === 0 || input.length > SKILL_LIMITS.files)
    error("SKILL.md", "A package must contain 1–100 files.");
  const seen = new Set<string>();
  let total = 0;
  for (const file of input) {
    try {
      validateSkillPath(file.path);
    } catch (cause) {
      if (cause instanceof SkillPackageError) findings.push(...cause.findings);
      else throw cause;
    }
    const key = file.path.normalize("NFC").toLowerCase();
    if (seen.has(key)) error(file.path, "Duplicate or normalized colliding file path.");
    seen.add(key);
    if (isBinarySkillFile(file)) {
      total += file.binary.size;
      if (file.path === "SKILL.md") error(file.path, "SKILL.md must be text.");
      else if (file.binary.size < 1 || file.binary.size > SKILL_LIMITS.binaryFileBytes)
        error(file.path, "File exceeds the supported size limit.");
      continue;
    }
    const bytes = new TextEncoder().encode(file.content);
    total += bytes.length;
    if (bytes.length > (file.path === "SKILL.md" ? SKILL_LIMITS.rootBytes : SKILL_LIMITS.fileBytes))
      error(file.path, "File exceeds the supported size limit.");
    try {
      decodeSkillText(bytes, file.path);
    } catch (cause) {
      if (cause instanceof SkillPackageError) findings.push(...cause.findings);
      else throw cause;
    }
    if (/[\ud800-\udfff]/u.test(file.content.replace(/[\ud800-\udbff][\udc00-\udfff]/gu, "")))
      error(file.path, "Unpaired Unicode surrogate.");
  }
  for (const file of input) {
    const parts = file.path.toLowerCase().split("/");
    for (let i = 1; i < parts.length; i++)
      if (seen.has(parts.slice(0, i).join("/")))
        error(file.path, "A parent folder collides with a file.");
  }
  if (total > SKILL_LIMITS.expandedBytes) error("SKILL.md", "Expanded package exceeds 50 MiB.");
  const found = input.find((file) => file.path === "SKILL.md");
  const root = found && !isBinarySkillFile(found) ? found : undefined;
  const match = root?.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  let metadata: SkillMetadata = { name: "", description: "", manualOnly: false };
  if (!match) error("SKILL.md", "Root SKILL.md must begin with YAML frontmatter.", 1);
  else {
    const document = parseDocument(match[1]!, {
      uniqueKeys: true,
      schema: "core",
      strict: true,
      version: "1.2",
    });
    for (const problem of [...document.errors, ...document.warnings])
      error("SKILL.md", problem.message, (problem.linePos?.[0]?.line ?? 1) + 1);
    let value: unknown;
    try {
      value = document.toJS({ maxAliasCount: 0 });
    } catch {
      error("SKILL.md", "YAML aliases are not supported.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      error("SKILL.md", "Frontmatter must be a mapping.");
    else {
      const fields = value as Record<string, unknown>;
      if (
        typeof fields.name !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(fields.name) ||
        fields.name.length > 64
      )
        error("SKILL.md", "name must be 1–64 lowercase letters, digits and single hyphens.");
      if (
        typeof fields.description !== "string" ||
        !fields.description.trim() ||
        fields.description.length > 1024
      )
        error("SKILL.md", "description must be 1–1024 characters.");
      if (
        fields["disable-model-invocation"] !== undefined &&
        typeof fields["disable-model-invocation"] !== "boolean"
      )
        error("SKILL.md", "disable-model-invocation must be a boolean.");
      metadata = {
        name: typeof fields.name === "string" ? fields.name : "",
        description: typeof fields.description === "string" ? fields.description : "",
        manualOnly: fields["disable-model-invocation"] === true,
      };
      for (const key of Object.keys(fields)) {
        if (
          ![
            "name",
            "description",
            "license",
            "compatibility",
            "metadata",
            "disable-model-invocation",
          ].includes(key)
        )
          findings.push({
            severity: "warning",
            path: "SKILL.md",
            message: `${key} is preserved but does not change execution, tools or permissions.`,
          });
      }
    }
    if (root && /!`|\$\(/u.test(root.content))
      findings.push({
        severity: "warning",
        path: "SKILL.md",
        message: "Shell substitutions are literal text and will not execute.",
      });
  }
  if (findings.some((finding) => finding.severity === "error"))
    throw new SkillPackageError(findings);
  return {
    files: input
      .map((file) => ({ ...file }))
      .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    metadata,
    findings,
  };
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const YAML_OPTIONS = { uniqueKeys: true, schema: "core", strict: true, version: "1.2" } as const;

/** The parts of SKILL.md the simple editor shows; the rest of the frontmatter is left alone. */
export interface SkillDocument {
  name: string;
  description: string;
  manualOnly: boolean;
  body: string;
}

/** Null when SKILL.md has no readable frontmatter; that skill is edited as files. */
export function readSkillDocument(content: string): SkillDocument | null {
  const match = content.match(FRONTMATTER);
  if (!match) return null;
  const document = parseDocument(match[1]!, YAML_OPTIONS);
  if (document.errors.length > 0) return null;
  let fields: unknown;
  try {
    fields = document.toJS({ maxAliasCount: 0 });
  } catch {
    return null;
  }
  if (fields !== null && (typeof fields !== "object" || Array.isArray(fields))) return null;
  const record = (fields ?? {}) as Record<string, unknown>;
  return {
    name: typeof record.name === "string" ? record.name : "",
    description: typeof record.description === "string" ? record.description : "",
    manualOnly: record["disable-model-invocation"] === true,
    // One blank line conventionally separates frontmatter from the text.
    body: content.slice(match[0].length).replace(/^\r?\n/u, ""),
  };
}

/** Rewrites only the simple editor's fields, keeping other keys and comments as written. */
export function writeSkillDocument(content: string, fields: SkillDocument): string {
  const match = content.match(FRONTMATTER);
  const document = parseDocument(match?.[1] ?? "", YAML_OPTIONS);
  document.set("name", fields.name);
  document.set("description", fields.description);
  if (fields.manualOnly) document.set("disable-model-invocation", true);
  else document.delete("disable-model-invocation");
  return `---\n${document.toString().trimEnd()}\n---\n\n${fields.body}`;
}

/** Skill names are identifiers; this turns what someone types into one as they type. */
export const toSkillName = (typed: string) =>
  typed
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[\s_]+/gu, "-")
    .replace(/[^a-z0-9-]/gu, "")
    .replace(/-{2,}/gu, "-")
    .slice(0, 64);

export const NEW_SKILL_FILES: SkillTextFile[] = [
  {
    path: "SKILL.md",
    content:
      "---\nname: new-skill\ndescription: Describe when to use this skill.\n---\n\n# Instructions\n\nDescribe the task and how to approach it.\n",
  },
];
