import { columnLetters } from "@chat/sheet/a1";
import { quoteSheet } from "@chat/sheet/model/formula";
import type { PivotDraft } from "./pivot-dialog.tsx";

/**
 * The GROUPBY or PIVOTBY formula a pivot table is: each field a whole column
 * of the data, absolute and named by its sheet, so the pivot can sit anywhere.
 */
export function pivotFormula(
  sheetName: string,
  box: { readonly top: number; readonly bottom: number; readonly left: number },
  draft: PivotDraft,
) {
  const column = (at: number) => {
    const letters = columnLetters(box.left + at);
    return `${quoteSheet(sheetName)}!$${letters}$${box.top}:$${letters}$${box.bottom}`;
  };
  const headers = draft.headers ? 3 : 0;
  return draft.columns === null
    ? `=GROUPBY(${column(draft.rows)},${column(draft.values)},${draft.summary},${headers})`
    : `=PIVOTBY(${column(draft.rows)},${column(draft.columns)},${column(draft.values)},${draft.summary},${headers})`;
}
