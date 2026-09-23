import type { ReactNode } from "react";
import { NeemaGlyph } from "~/ui/brand.tsx";

/** The page around a signed-out card: the mark, then the card, centred. */
export function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 p-4">
      <div className="flex items-center gap-2">
        <span className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg">
          <NeemaGlyph className="size-5" />
        </span>
        <span className="text-lg font-semibold">neema</span>
      </div>
      {children}
    </div>
  );
}
