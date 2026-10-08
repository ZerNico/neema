// The renderer Streamdown sees for a ```ui fence. Light on purpose: it lives
// in the chat bundle and owns the block's height and placeholder, so loading
// the code, waiting for QuickJS, streaming and the finished block all happen
// in one container that glides between sizes instead of swapping boxes.

import { lazy, Suspense } from "react";
import type { CustomRendererProps } from "streamdown";
import { Skeleton } from "~/ui/primitives/skeleton";
import { SmoothHeight } from "./smooth-height.tsx";

const UiBlock = lazy(() => import("./ui-block.tsx"));

/** The one placeholder a block shows until its tree is ready. */
export function BlockSkeleton() {
  return <Skeleton className="h-24 w-full" />;
}

export default function UiBlockFrame(props: CustomRendererProps) {
  return (
    <SmoothHeight>
      <Suspense fallback={<BlockSkeleton />}>
        <UiBlock {...props} />
      </Suspense>
    </SmoothHeight>
  );
}
