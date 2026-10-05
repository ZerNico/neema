import { NeemaGlyph } from "./brand";

/**
 * Server-rendered before hydration, so the fade is pure CSS. The delay keeps a
 * fast load from flashing the mark at all.
 */
export function StartupPending() {
  return (
    <div
      data-slot="startup-pending"
      role="status"
      aria-label="Loading"
      className="text-muted-foreground flex h-svh max-h-full items-center justify-center"
    >
      <div className="animate-in fade-in fill-mode-both delay-300 duration-700">
        <NeemaGlyph className="size-9 motion-safe:animate-pulse" />
      </div>
    </div>
  );
}
