/**
 * The Office file families the app edits. Kept alone so the database schema
 * can name them without importing the families' runtime code.
 */
export const OFFICE_FAMILY_NAMES = ["presentation", "spreadsheet", "word"] as const;
export type OfficeFamily = (typeof OFFICE_FAMILY_NAMES)[number];
