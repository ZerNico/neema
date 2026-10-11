import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { IMAGE_MEDIA_TYPES } from "~/modules/attachments/constants.ts";
import { uploadAttachment } from "~/modules/attachments/server/functions.ts";
import { toastError } from "~/ui/error-toast.ts";
import { addDocumentImage } from "../../server/document-functions.ts";

/** The document each editable editor puts its images in; absent while read-only. */
const targets = new WeakMap<Editor, string>();
export const setImageTarget = (editor: Editor, documentId: string | null) => {
  if (documentId === null) targets.delete(editor);
  else targets.set(editor, documentId);
};
export const canAddImages = (editor: Editor) => targets.has(editor);

const isImage = (file: File) => (IMAGE_MEDIA_TYPES as ReadonlyArray<string>).includes(file.type);

/**
 * Where each running upload will land, carried through every transaction so
 * typing and collaborators' steps meanwhile move it like any position.
 */
type Pending = ReadonlyMap<symbol, number>;
type PendingMeta = { add: symbol; at: number } | { remove: symbol };
const pendingKey = new PluginKey<Pending>("imageUploads");

const setPending = (editor: Editor, meta: PendingMeta) =>
  editor.view.dispatch(editor.state.tr.setMeta(pendingKey, meta).setMeta("addToHistory", false));

const upload = async (documentId: string, file: File) => {
  const data = new FormData();
  data.set("file", file);
  const attachment = await uploadAttachment({ data });
  const src = await addDocumentImage({ data: { documentId, attachmentId: attachment.id } });
  return { src, alt: file.name };
};

/**
 * Uploads the image files among `files`, claims them for the document and
 * puts them at `at`, in order, once they are all in.
 */
export const addImages = async (editor: Editor, files: ReadonlyArray<File>, at: number) => {
  const documentId = targets.get(editor);
  const images = files.filter(isImage);
  if (!documentId || images.length === 0) return;
  const id = Symbol("upload");
  setPending(editor, { add: id, at });
  const results = await Promise.allSettled(images.map((file) => upload(documentId, file)));
  if (editor.isDestroyed) return;
  const position = pendingKey.getState(editor.state)?.get(id);
  setPending(editor, { remove: id });
  const added = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  if (position !== undefined && added.length > 0)
    editor.commands.insertContentAt(
      position,
      added.map((attrs) => ({ type: "image", attrs })),
    );
  const failed = results.find((result) => result.status === "rejected");
  if (failed)
    toastError(
      images.length > 1 ? "Could not add every image" : "Could not add the image",
      failed.reason,
    );
};

/** Opens the file picker for images, to go where the selection is now. */
export const pickImages = (editor: Editor) => {
  const documentId = targets.get(editor);
  if (!documentId) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = IMAGE_MEDIA_TYPES.join(",");
  input.multiple = true;
  const at = editor.state.selection.from;
  const id = Symbol("picking");
  setPending(editor, { add: id, at });
  const release = () => {
    const position = pendingKey.getState(editor.state)?.get(id) ?? at;
    if (!editor.isDestroyed) setPending(editor, { remove: id });
    return position;
  };
  input.addEventListener("change", () => {
    const position = release();
    void addImages(editor, [...(input.files ?? [])], position);
  });
  input.addEventListener("cancel", release);
  input.click();
};

/** Pasted or dropped image files are uploaded rather than ignored. */
export const ImageUpload = Extension.create({
  name: "imageUpload",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin<Pending>({
        key: pendingKey,
        state: {
          init: () => new Map(),
          apply: (tr, pending) => {
            const meta = tr.getMeta(pendingKey) as PendingMeta | undefined;
            if (!tr.docChanged && !meta) return pending;
            const next = new Map<symbol, number>();
            for (const [id, at] of pending) next.set(id, tr.mapping.map(at));
            if (meta && "add" in meta) next.set(meta.add, meta.at);
            if (meta && "remove" in meta) next.delete(meta.remove);
            return next;
          },
        },
        props: {
          handlePaste: (view, event) => {
            const files = [...(event.clipboardData?.files ?? [])].filter(isImage);
            if (!canAddImages(editor) || files.length === 0) return false;
            void addImages(editor, files, view.state.selection.from);
            return true;
          },
          handleDrop: (view, event, _slice, moved) => {
            const files = [...(event.dataTransfer?.files ?? [])].filter(isImage);
            if (moved || !canAddImages(editor) || files.length === 0) return false;
            event.preventDefault();
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            void addImages(editor, files, at ?? view.state.selection.from);
            return true;
          },
        },
      }),
    ];
  },
});
