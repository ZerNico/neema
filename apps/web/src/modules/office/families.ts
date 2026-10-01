import {
  DOCX_MEDIA_TYPE,
  fileExtension,
  GENERIC_MEDIA_TYPE,
  PPTX_MEDIA_TYPE,
  XLSX_MEDIA_TYPE,
} from "~/modules/attachments/constants.ts";
import { presentationActivitySummary } from "~/modules/presentations/activity.ts";
import {
  PresentationToolEnvelope,
  PresentationToolName,
} from "~/modules/presentations/tool-schema.ts";
import { spreadsheetActivitySummary } from "~/modules/spreadsheets/activity.ts";
import {
  SpreadsheetToolEnvelope,
  SpreadsheetToolName,
} from "~/modules/spreadsheets/tool-schema.ts";
import { wordActivitySummary } from "~/modules/word/activity.ts";
import { WordToolEnvelope, WordToolName } from "~/modules/word/tool-schema.ts";
import { OFFICE_FAMILY_NAMES, type OfficeFamily } from "./names.ts";

export { OFFICE_FAMILY_NAMES, type OfficeFamily } from "./names.ts";

/**
 * What the app knows about each Office family, in one place. The stream,
 * the reload projection, working files, previews and tool wording all read
 * this, so adding a family is an entry here plus its module; the places
 * that need more (UI wording, server tools) are tables keyed by family,
 * which the compiler makes complete.
 */
export const OFFICE_FAMILIES = {
  presentation: {
    extension: "pptx",
    mediaType: PPTX_MEDIA_TYPE,
    /** Product and file, as tool messages name them. */
    label: "Presentation",
    app: "PowerPoint",
    file: "a .pptx presentation",
    draft: "a presentation draft",
    inspect: "inspect_presentation",
    edit: "edit_presentation",
    names: PresentationToolName,
    envelope: PresentationToolEnvelope,
    summary: presentationActivitySummary,
    failure: "PresentationFailed",
  },
  spreadsheet: {
    extension: "xlsx",
    mediaType: XLSX_MEDIA_TYPE,
    label: "Spreadsheet",
    app: "Excel",
    file: "an .xlsx workbook",
    draft: "a spreadsheet draft",
    inspect: "inspect_spreadsheet",
    edit: "edit_spreadsheet",
    names: SpreadsheetToolName,
    envelope: SpreadsheetToolEnvelope,
    summary: spreadsheetActivitySummary,
    failure: "SpreadsheetFailed",
  },
  word: {
    extension: "docx",
    mediaType: DOCX_MEDIA_TYPE,
    label: "Word",
    app: "Word",
    file: "a .docx document",
    draft: "a Word draft",
    inspect: "inspect_word_file",
    edit: "edit_word_file",
    names: WordToolName,
    envelope: WordToolEnvelope,
    summary: wordActivitySummary,
    failure: "WordFailed",
  },
} as const satisfies Record<OfficeFamily, unknown>;

export const isOfficeFamily = (value: unknown): value is OfficeFamily =>
  (OFFICE_FAMILY_NAMES as readonly unknown[]).includes(value);

/** The family whose tools include `name`, or null. */
export const officeFamilyOfTool = (name: string): OfficeFamily | null =>
  OFFICE_FAMILY_NAMES.find((family) =>
    (OFFICE_FAMILIES[family].names.literals as readonly string[]).includes(name),
  ) ?? null;

/** The family whose long edit call `name` is: shown while the model writes it. */
export const officeFamilyOfEdit = (name: string): OfficeFamily | null =>
  OFFICE_FAMILY_NAMES.find((family) => OFFICE_FAMILIES[family].edit === name) ?? null;

/**
 * The family of a stored file. A specific media type decides; a generic or
 * missing one falls back to the extension.
 */
export function officeFamilyOfFile(file: {
  readonly name: string;
  readonly mediaType?: string | undefined;
}): OfficeFamily | null {
  const specific = file.mediaType && file.mediaType !== GENERIC_MEDIA_TYPE;
  const extension = fileExtension(file.name);
  return (
    OFFICE_FAMILY_NAMES.find((family) =>
      specific
        ? OFFICE_FAMILIES[family].mediaType === file.mediaType
        : OFFICE_FAMILIES[family].extension === extension,
    ) ?? null
  );
}
