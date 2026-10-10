import { useMemo, useState } from "react";
import { columnLetters } from "@chat/sheet/a1";
import { sheetLocale } from "@chat/sheet/locales";
import { calculateSheet } from "@chat/sheet/model/calc";
import { liveSheets, positions } from "@chat/sheet/model";
import { cellSource } from "@chat/sheet-react/display";
import { SheetGrid, type SheetSelection } from "@chat/sheet-react/grid";
import { Button } from "~/ui/primitives/button";
import { Spinner } from "~/ui/primitives/spinner";
import type { SheetController } from "../client/use-sheet.ts";

/**
 * An open sheet: the formula bar, the grid and the sheet tabs. Values are
 * calculated here from the document and the moment its revision carries,
 * as every other replica calculates them.
 */
export default function SheetPanelBody({ controller }: { controller: SheetController }) {
  const state = controller.state;
  const doc = state?.doc ?? null;
  const [chosen, setChosen] = useState<string | null>(null);
  const [selection, setSelection] = useState<SheetSelection | null>(null);
  const sheets = useMemo(() => (doc ? liveSheets(doc) : []), [doc]);
  const sheet = chosen && sheets.includes(chosen) ? chosen : (sheets[0] ?? null);
  const values = useMemo(
    () =>
      doc && state
        ? calculateSheet(doc, { revision: state.revision, epoch: 0, ...state.moment })
        : null,
    [doc, state],
  );
  if (!doc || !values || !sheet || !state)
    return <Spinner aria-label="Connecting to sheet" className="text-muted-foreground" />;
  const locale = sheetLocale(doc.settings.locale);
  const rows = positions(doc.sheet[sheet]!.rows);
  const cols = positions(doc.sheet[sheet]!.cols);
  const active =
    selection && rows.at(selection.head.r) !== undefined && cols.at(selection.head.c) !== undefined
      ? selection.head
      : null;
  return (
    // Pulled to the panel's edges, as the text editor is: the grid scrolls on its own.
    <div className="-m-4 flex min-h-48 min-w-0 flex-1 flex-col">
      <div className="border-border flex h-8 shrink-0 items-center gap-3 border-b px-3 text-sm">
        <span className="text-muted-foreground w-14 shrink-0 font-mono text-xs">
          {active ? `${columnLetters(cols.at(active.c)!)}${rows.at(active.r)}` : ""}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {active ? cellSource(doc, sheet, active.r, active.c, locale) : ""}
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0">
          <SheetGrid
            key={sheet}
            doc={doc}
            sheet={sheet}
            values={values}
            locale={locale}
            selection={active ? selection : null}
            onSelectionChange={setSelection}
            label={doc.sheet[sheet]!.name}
          />
        </div>
      </div>
      {sheets.length > 1 ? (
        <div
          role="tablist"
          aria-label="Sheets"
          className="border-border flex shrink-0 gap-1 overflow-x-auto border-t px-2 py-1"
        >
          {sheets.map((id) => (
            <Button
              key={id}
              role="tab"
              aria-selected={id === sheet}
              size="xs"
              variant={id === sheet ? "secondary" : "ghost"}
              onClick={() => {
                setChosen(id);
                setSelection(null);
              }}
            >
              {doc.sheet[id]!.name}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
