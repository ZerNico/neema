import { compileDesktopMessages } from "../web/paraglide.ts";

/**
 * The desktop's own words are the web app's messages, compiled into `src/paraglide` like the
 * page's, so the two never drift (docs/internals/i18n.md).
 */
export const compileMessages = () =>
  compileDesktopMessages(new URL("./src/paraglide", import.meta.url).pathname);
