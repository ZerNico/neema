import { useQuery } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { liveSheets } from "@chat/sheet/model";
import { chartData } from "@chat/sheet/model/chart";
import { usedExtent } from "@chat/sheet-react/commands";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { documentQuery } from "../../client/document-queries.ts";
import type { SheetEmbedAttrs } from "../../editor/sheet-embed.ts";
import { embedTable, rangeText } from "../../sheet/embed-range.ts";
import { listDocuments, listProjectDocuments } from "../../server/document-functions.ts";
import { sheetEmbedHub } from "./sheet-embeds.ts";

const CELLS = "cells";

/**
 * Picks what to embed: a live sheet of the same chat or project, then a range
 * of it (the used area to start with) or one of its charts. The chosen sheet
 * is read through the editor's hub, as an embed of it would be.
 */
export default function SheetEmbedPicker({
  editor,
  documentId,
  onClose,
}: {
  editor: Editor;
  documentId: string;
  onClose: () => void;
}) {
  const id = useId();
  const owner = useQuery(documentQuery(documentId)).data;
  const sheets = useQuery({
    queryKey: ["documents", "sheets", owner?.conversationId ?? owner?.projectId],
    queryFn: async () => {
      const listed = owner?.conversationId
        ? await listDocuments({ data: { conversationId: owner.conversationId } })
        : await listProjectDocuments({ data: { projectId: owner!.projectId! } });
      return listed.filter((each) => each.kind === "sheet");
    },
    enabled: Boolean(owner?.conversationId ?? owner?.projectId),
  });
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [shown, setShown] = useState(CELLS);
  // Null until typed, so the field offers the chosen sheet's used area.
  const [typed, setTyped] = useState<string | null>(null);
  const hub = sheetEmbedHub(editor);
  useEffect(() => (sheetId ? hub.acquire(sheetId) : undefined), [hub, sheetId]);
  const source = useSyncExternalStore(
    hub.subscribe,
    () => hub.source(sheetId ?? ""),
    () => hub.source(sheetId ?? ""),
  );
  const doc = source.status === "ready" ? source.doc : null;
  const values = source.status === "ready" ? source.values : null;
  const firstSheet = doc ? liveSheets(doc)[0] : undefined;
  const usedArea = (() => {
    if (!doc || !values || !firstSheet) return "";
    const { bottom, right } = usedExtent({ doc, values }, firstSheet);
    const box = { top: 1, left: 1, bottom: Math.max(1, bottom), right: Math.max(1, right) };
    return rangeText(doc.sheet[firstSheet]!.name, box);
  })();
  const range = typed ?? usedArea;
  const charts =
    doc && values
      ? Object.entries(doc.charts)
          .filter(([, chart]) => doc.sheet[chart.sheet])
          .map(([chartId, chart], index) => ({
            value: chartId,
            label: chartData(doc, values, chart).title || `Chart ${index + 1}`,
          }))
      : [];
  const rangeFits = doc && values ? embedTable(doc, values, range.trim()) !== null : false;
  const choices = [{ value: CELLS, label: "Cells" }, ...charts];
  const ready = sheetId !== null && doc !== null && (shown === CELLS ? rangeFits : true);
  const listed = sheets.data ?? [];

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Insert from a sheet</DialogTitle>
          <DialogDescription>
            It shows the sheet’s current values and keeps up as they change.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready || !sheetId) return;
            onClose();
            const attrs: SheetEmbedAttrs =
              shown === CELLS
                ? { sheet: sheetId, range: range.trim(), chart: null }
                : { sheet: sheetId, range: null, chart: shown };
            // A block of its own where the selection is, in place of an empty paragraph.
            editor.chain().focus().insertContent({ type: "sheetEmbed", attrs }).run();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-sheet`}>Sheet</FieldLabel>
              {sheets.isSuccess && !listed.length ? (
                <FieldDescription>This chat has no live sheets yet.</FieldDescription>
              ) : (
                <Select
                  items={listed.map((each) => ({ value: each.id, label: each.title }))}
                  value={sheetId}
                  onValueChange={(next) => {
                    setSheetId(next);
                    setShown(CELLS);
                    setTyped(null);
                  }}
                >
                  <SelectTrigger id={`${id}-sheet`} className="w-full">
                    <SelectValue placeholder="Choose a sheet" />
                  </SelectTrigger>
                  <SelectContent>
                    {listed.map((each) => (
                      <SelectItem key={each.id} value={each.id}>
                        {each.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            {sheetId && source.status === "unavailable" ? (
              <FieldError>This sheet isn’t available.</FieldError>
            ) : null}
            {doc ? (
              <Field>
                <FieldLabel htmlFor={`${id}-shown`}>Show</FieldLabel>
                <Select
                  items={choices}
                  value={shown}
                  onValueChange={(next) => setShown(next ?? CELLS)}
                >
                  <SelectTrigger id={`${id}-shown`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {choices.map((choice) => (
                      <SelectItem key={choice.value} value={choice.value}>
                        {choice.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            {doc && shown === CELLS ? (
              <Field>
                <FieldLabel htmlFor={`${id}-range`}>Range</FieldLabel>
                <Input
                  id={`${id}-range`}
                  value={range}
                  placeholder="Data!A1:D9"
                  onChange={(event) => setTyped(event.target.value)}
                  aria-invalid={!rangeFits || undefined}
                />
                {rangeFits ? null : (
                  <FieldError>Name a sheet of it and its cells, like Data!A1:D9.</FieldError>
                )}
              </Field>
            ) : null}
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!ready}>
              Insert
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
