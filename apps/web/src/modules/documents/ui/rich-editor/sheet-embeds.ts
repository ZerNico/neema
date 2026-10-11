import type { Editor } from "@tiptap/core";
import type { SheetDoc } from "@chat/sheet/model";
import type { SheetValues } from "@chat/sheet/model/calc";

/** One embedded sheet as every embed of it reads it. */
export interface EmbedSource {
  readonly status: "loading" | "ready" | "unavailable";
  readonly title: string | null;
  readonly doc: SheetDoc | null;
  readonly values: SheetValues | null;
}
const LOADING: EmbedSource = { status: "loading", title: null, doc: null, values: null };

/**
 * The sheets an editor's embeds show, each held while any embed of it is
 * drawn. Embeds ask for a sheet here; one source per sheet subscribes and
 * calculates (`sheet-embed-sources.tsx`), so ten embeds of one sheet hold one
 * feed and one calculation.
 */
export class SheetEmbedHub {
  #held = new Map<string, number>();
  #sources = new Map<string, EmbedSource>();
  #ids: readonly string[] = [];
  #listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #changed() {
    for (const listener of this.#listeners) listener();
  }
  /** Holds a sheet while an embed shows it; the returned function lets go. */
  acquire(sheetId: string) {
    const held = this.#held.get(sheetId) ?? 0;
    this.#held.set(sheetId, held + 1);
    if (!held) this.#ids = [...this.#held.keys()];
    this.#changed();
    return () => {
      const count = (this.#held.get(sheetId) ?? 1) - 1;
      if (count > 0) this.#held.set(sheetId, count);
      else {
        this.#held.delete(sheetId);
        this.#ids = [...this.#held.keys()];
      }
      this.#changed();
    };
  }
  /** The sheets held now, the same array until that changes. */
  ids = () => this.#ids;
  source = (sheetId: string) => this.#sources.get(sheetId) ?? LOADING;
  /** Drops what a source published once its sheet is no longer held, as its source unmounts. */
  forget(sheetId: string) {
    if (!this.#held.has(sheetId)) this.#sources.delete(sheetId);
  }
  publish(sheetId: string, source: EmbedSource) {
    if (!this.#held.has(sheetId)) return;
    this.#sources.set(sheetId, source);
    this.#changed();
  }
}

const hubs = new WeakMap<Editor, SheetEmbedHub>();
/** The editor's hub, made on first use: the editor outlives the panel that draws it. */
export const sheetEmbedHub = (editor: Editor) => {
  let hub = hubs.get(editor);
  if (!hub) {
    hub = new SheetEmbedHub();
    hubs.set(editor, hub);
  }
  return hub;
};

/** Who wants the sheet picker opened, per editor: the ribbon and the `/` menu both ask. */
const pickers = new WeakMap<Editor, () => void>();
export const setSheetPicker = (editor: Editor, open: (() => void) | null) => {
  if (open) pickers.set(editor, open);
  else pickers.delete(editor);
};
export const canPickSheet = (editor: Editor) => pickers.has(editor);
export const openSheetPicker = (editor: Editor) => pickers.get(editor)?.();
