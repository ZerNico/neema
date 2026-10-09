// The ui block renderer's code, loaded once for the page. Kept apart from the
// frame so the early start (client/prewarm.ts) and the frame share one load.

type UiBlockModule = typeof import("./ui-block.tsx");

let loaded: UiBlockModule["default"] | null = null;
let loading: Promise<UiBlockModule> | null = null;

/** Loads the renderer's code; once it is in, frames render it directly. */
export function loadUiBlock(): Promise<UiBlockModule> {
  loading ??= import("./ui-block.tsx").then((module) => {
    loaded = module.default;
    return module;
  });
  return loading;
}

/** The renderer, if its code has loaded. */
export const loadedUiBlock = (): UiBlockModule["default"] | null => loaded;
