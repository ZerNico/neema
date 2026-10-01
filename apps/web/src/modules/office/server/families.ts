import { Effect, Option } from "effect";
import type { FontFace } from "~/modules/presentations/server/font-file.ts";
import { PresentationProcessor } from "~/modules/presentations/server/processor.ts";
import {
  preparePresentationTools,
  type PresentationToolHost,
} from "~/modules/presentations/server/tools.ts";
import { SpreadsheetProcessor } from "~/modules/spreadsheets/server/runtime.ts";
import { prepareSpreadsheetTools } from "~/modules/spreadsheets/server/tools.ts";
import type { ToolGroup } from "~/modules/tools/server/toolset.ts";
import { WordProcessor } from "~/modules/word/server/runtime.ts";
import { prepareWordTools } from "~/modules/word/server/tools.ts";
import { withRunOptions } from "~/server/jobs.ts";
import { OFFICE_FAMILY_NAMES, type OfficeFamily } from "../families.ts";
import type { OfficeToolHost } from "./tool-kit.ts";

/** Each family's worker processes, where this server runs them. */
export const officeProcessors = Effect.all({
  presentation: Effect.serviceOption(PresentationProcessor),
  spreadsheet: Effect.serviceOption(SpreadsheetProcessor),
  word: Effect.serviceOption(WordProcessor),
});
export type OfficeProcessors = Effect.Success<typeof officeProcessors>;

/** The families this server can edit: those whose workers run here. */
export const runnableOfficeFamilies = (processors: OfficeProcessors) =>
  OFFICE_FAMILY_NAMES.filter((family) => Option.isSome<unknown>(processors[family]));

export interface OfficeAttempt extends OfficeToolHost {
  /** The sender; one person's jobs share a cap. */
  readonly owner: string;
  /** PowerPoint alone draws: fonts of loaded skills, the families decks may use, vision feedback. */
  readonly presentation: Pick<PresentationToolHost, "fonts" | "onPreview"> & {
    readonly faces: () => Promise<readonly FontFace[]>;
  };
}

/** The tool groups of every family this server runs, in registry order. */
export function prepareOfficeTools(processors: OfficeProcessors, attempt: OfficeAttempt) {
  const { owner, workingFiles, resolveFile } = attempt;
  const groups = {
    presentation: Option.map(
      processors.presentation,
      (processor) =>
        preparePresentationTools({
          runtime: withRunOptions(processor, async () => ({
            owner,
            faces: await attempt.presentation.faces(),
          })),
          workingFiles,
          resolveFile,
          ...(attempt.presentation.fonts ? { fonts: attempt.presentation.fonts } : {}),
          ...(attempt.presentation.onPreview ? { onPreview: attempt.presentation.onPreview } : {}),
        }).group,
    ),
    spreadsheet: Option.map(
      processors.spreadsheet,
      (processor) =>
        prepareSpreadsheetTools({
          runtime: withRunOptions(processor, () => ({ owner })),
          workingFiles,
          resolveFile,
        }).group,
    ),
    word: Option.map(
      processors.word,
      (processor) =>
        prepareWordTools({
          runtime: withRunOptions(processor, () => ({ owner })),
          workingFiles,
          resolveFile,
        }).group,
    ),
  } satisfies Record<OfficeFamily, Option.Option<ToolGroup>>;
  return OFFICE_FAMILY_NAMES.flatMap((family) =>
    Option.match(groups[family], {
      onNone: () => [],
      onSome: (group) => [{ family, group }],
    }),
  );
}
