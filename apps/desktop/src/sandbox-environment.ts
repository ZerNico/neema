import { platform } from "node:os";
import { posix, win32 } from "node:path";

// Identity, locale and terminal only. Runtime injection variables and launch
// settings from the desktop's own environment are not the command's to inherit.
const CHILD_ENVIRONMENT = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "LC_NUMERIC",
  "LC_TIME",
  "TZ",
  "TERM",
  "COLORTERM",
  // Windows needs these to start most programs at all.
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
]);

/**
 * The environment a sandboxed command starts with: the desktop's identity and
 * locale, temporary files and caches inside the chat's workspace, and the
 * proxy settings for this command.
 *
 * Caches go to the workspace because the home directory is unreadable inside
 * the sandbox. Libraries create those directories themselves, inside
 * confinement, so nothing host-side follows a workspace symlink.
 */
export const commandEnvironment = (
  parent: NodeJS.ProcessEnv,
  cwd: string,
  proxy: Readonly<Record<string, string>>,
  os = platform(),
): Record<string, string> => {
  const path = os === "win32" ? win32 : posix;
  const cache = path.join(cwd, ".cache");
  const inherited = Object.entries(parent).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && CHILD_ENVIRONMENT.has(entry[0].toUpperCase()),
  );
  return {
    ...Object.fromEntries(inherited),
    TEMP: cwd,
    TMP: cwd,
    // MSYS tools on Windows misread a POSIX TMPDIR.
    ...(os === "win32" ? {} : { TMPDIR: cwd }),
    XDG_CACHE_HOME: cache,
    npm_config_cache: path.join(cache, "npm"),
    PIP_CACHE_DIR: path.join(cache, "pip"),
    UV_CACHE_DIR: path.join(cache, "uv"),
    MPLCONFIGDIR: path.join(cache, "matplotlib"),
    ...proxy,
  };
};
