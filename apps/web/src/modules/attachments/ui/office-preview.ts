import { officeFamilyOfFile, type OfficeFamily } from "~/modules/office/families.ts";

/** An authorized, server-rendered source; never inferred from a download URL. */
export interface OfficeFile {
  /** A skill file's id is `<skillId>:<sha256>`, readable by the skill's owner. */
  readonly kind: "attachment" | "project-version" | "skill-file";
  readonly id: string;
}
/** Which Office preview a file gets. */
export interface OfficePreview {
  readonly type: OfficeFamily;
  readonly source: OfficeFile;
}

/** The preview an Office file gets, else null; the family is decided as `officeFamilyOfFile` does. */
export function officePreview(
  file: { readonly fileName: string; readonly mediaType?: string | undefined },
  source: OfficeFile,
): OfficePreview | null {
  const type = officeFamilyOfFile({ name: file.fileName, mediaType: file.mediaType });
  return type ? { type, source } : null;
}
