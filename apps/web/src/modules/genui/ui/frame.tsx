// The renderer Streamdown sees for a ```ui fence. Light on purpose: it lives
// in the chat bundle and owns the block's height and placeholder, so loading
// the code, waiting for QuickJS, streaming and the finished block all happen
// in one container that glides between sizes instead of swapping boxes.

import { lazy, Suspense, useState } from "react";
import type { CustomRendererProps } from "streamdown";
import { Skeleton } from "~/ui/primitives/skeleton";
import { loadedUiBlock, loadUiBlock } from "./load-block.ts";
import { SmoothHeight } from "./smooth-height.tsx";

// Only until the code is in: React.lazy suspends on first render even for a
// loaded module, and React holds a revealed fallback back for a moment, so a
// block whose tree was ready would still blink as a placeholder.
const UiBlock = lazy(loadUiBlock);

/** The one placeholder a block shows until its tree is ready. */
export function BlockSkeleton() {
  return <Skeleton className="h-24 w-full" />;
}

export default function UiBlockFrame(props: CustomRendererProps) {
  // Chosen once per frame: switching from the lazy path mid-life would remount the block.
  const [Loaded] = useState(loadedUiBlock);
  return (
    <SmoothHeight>
      {Loaded ? (
        // oxlint-disable-next-line react/static-components -- one module-level component, read once loaded; never made here
        <Loaded {...props} />
      ) : (
        <Suspense fallback={<BlockSkeleton />}>
          <UiBlock {...props} />
        </Suspense>
      )}
    </SmoothHeight>
  );
}
