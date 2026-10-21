import { lazy, Suspense, useState, type ComponentProps } from "react";
import type { AttachmentPreviewDialog as PreviewDialog } from "./attachment-preview.tsx";

// The dialog brings the markdown renderer, the highlighter and the office
// previews. A chip in the composer is shown far more often than it is opened,
// so the page without a conversation does not download them up front.
const loadPreview = () => import("./attachment-preview.tsx");
const AttachmentPreviewDialog = lazy(() =>
  loadPreview().then((module) => ({ default: module.AttachmentPreviewDialog })),
);

/** Starts the download early, on the hover or focus that usually precedes a click. */
export const preloadAttachmentPreview = () => void loadPreview();

/** The preview dialog, fetched the first time it opens and kept for its closing animation. */
export function LazyAttachmentPreviewDialog(props: ComponentProps<typeof PreviewDialog>) {
  const [opened, setOpened] = useState(props.open);
  if (props.open && !opened) setOpened(true);
  if (!opened) return null;
  return (
    <Suspense fallback={null}>
      <AttachmentPreviewDialog {...props} />
    </Suspense>
  );
}
