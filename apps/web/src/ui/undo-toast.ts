import { toast } from "sonner";
import { m } from "~/paraglide/messages.js";

/** Long enough to read and reach for; hovering the toast pauses it. */
const UNDO_TOAST_MS = 8_000;

interface Pending {
  readonly id: string | number;
  readonly undo: () => void;
}

/** Newest last. ⌘Z takes the newest, the way an editor's undo stack does. */
const pending: Pending[] = [];

const settle = (id: string | number) => {
  const index = pending.findIndex((entry) => entry.id === id);
  if (index === -1) return null;
  const [entry] = pending.splice(index, 1);
  if (pending.length === 0) window.removeEventListener("keydown", onKeyDown);
  return entry ?? null;
};

const isMac = () => /Mac|iPhone|iPad/.test(navigator.userAgent);

// A field keeps its own undo: ⌘Z there edits text, never a chat list.
// The selector covers every contenteditable value; jsdom has no isContentEditable.
const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !==
      null);

function onKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.key.toLowerCase() !== "z") return;
  if (event.shiftKey || event.altKey || !(isMac() ? event.metaKey : event.ctrlKey)) return;
  if (editable(event.target)) return;
  const newest = pending.at(-1);
  if (!newest) return;
  event.preventDefault();
  settle(newest.id);
  toast.dismiss(newest.id);
  newest.undo();
}

/**
 * Says an action happened and offers to reverse it, by button or by ⌘Z
 * (Ctrl+Z elsewhere) while the toast is up. `kept` runs when the toast goes
 * without its Undo. Returns a dismiss for a caller whose action failed, so
 * nothing offers to undo what never happened; that dismiss runs neither.
 */
export function undoToast(message: string, undo: () => void, kept?: () => void) {
  const expire = () => {
    if (settle(id)) kept?.();
  };
  const id = toast(message, {
    duration: UNDO_TOAST_MS,
    action: {
      label: m.ui_undo(),
      onClick: () => {
        if (settle(id)) undo();
      },
    },
    onDismiss: expire,
    onAutoClose: expire,
  });
  if (pending.length === 0) window.addEventListener("keydown", onKeyDown);
  pending.push({ id, undo });
  return () => {
    settle(id);
    toast.dismiss(id);
  };
}
