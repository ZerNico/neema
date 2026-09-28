import { useRef, useState, type DragEvent } from "react";

/**
 * Drop-target handlers for files dragged from outside the page. dragenter and
 * dragleave fire for every child crossed, so a depth counter keeps the
 * highlight from flickering. Drags carrying no files, and every drag while
 * `enabled` is false, pass through untouched.
 */
export function useFileDrop({
  enabled,
  onDrop,
}: {
  enabled: boolean;
  onDrop: (files: FileList) => void;
}) {
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const accepts = (event: DragEvent) => enabled && event.dataTransfer.types.includes("Files");
  const handlers = {
    onDragEnter: (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (event: DragEvent) => {
      if (accepts(event)) event.preventDefault();
    },
    onDragLeave: (event: DragEvent) => {
      if (!accepts(event)) return;
      depth.current -= 1;
      if (depth.current <= 0) {
        depth.current = 0;
        setDragging(false);
      }
    },
    onDrop: (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      onDrop(event.dataTransfer.files);
    },
  };
  return { dragging, handlers };
}
