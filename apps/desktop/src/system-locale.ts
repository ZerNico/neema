/**
 * Main names the operating system's region format to the page's preload. The
 * page's own languages do not carry it: on a Mac set to English with German
 * formats they read "en-GB", while the system says "en-DE".
 */
export const SYSTEM_LOCALE_ARGUMENT = "--chat-desktop-system-locale";

const TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

export const systemLocaleFromArgv = (argv: readonly string[]) => {
  const flag = argv.find((argument) => argument.startsWith(`${SYSTEM_LOCALE_ARGUMENT}=`));
  const tag = flag?.slice(SYSTEM_LOCALE_ARGUMENT.length + 1);
  return tag && TAG.test(tag) ? tag : undefined;
};
