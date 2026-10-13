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

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * Maven reads proxies only from a settings file. The user's own is denied (it
 * holds credentials), so each command gets one naming the egress proxy and a
 * local repository in the workspace, since the user's is read-only here.
 */
export const mavenSettings = (proxyUrl: string, repository: string) => {
  const url = new URL(proxyUrl);
  const proxy = (protocol: string) =>
    `<proxy><id>egress-${protocol}</id><active>true</active><protocol>${protocol}</protocol>` +
    `<host>${escapeXml(url.hostname)}</host><port>${url.port}</port>` +
    `<username>${escapeXml(decodeURIComponent(url.username))}</username>` +
    `<password>${escapeXml(decodeURIComponent(url.password))}</password></proxy>`;
  return (
    `<settings><localRepository>${escapeXml(repository)}</localRepository>` +
    `<proxies>${proxy("https")}${proxy("http")}</proxies></settings>`
  );
};

/**
 * Java ignores the proxy variables. Gradle takes the proxy from GRADLE_OPTS,
 * which it passes on to its daemon without printing; JAVA_TOOL_OPTIONS would
 * print the token on every JVM start, so it carries only the IPv4 switch
 * Seatbelt's loopback rules need. Maven gets its settings file by path.
 */
export const jvmEnvironment = (
  proxyUrl: string,
  cache: string,
  settingsFile: string,
  os = platform(),
): Record<string, string> => {
  const path = os === "win32" ? win32 : posix;
  const url = new URL(proxyUrl);
  const proxy = ["https", "http"].flatMap((scheme) => [
    `-D${scheme}.proxyHost=${url.hostname}`,
    `-D${scheme}.proxyPort=${url.port}`,
    `-D${scheme}.proxyUser=${decodeURIComponent(url.username)}`,
    `-D${scheme}.proxyPassword=${decodeURIComponent(url.password)}`,
  ]);
  return {
    JAVA_TOOL_OPTIONS: "-Djava.net.preferIPv4Stack=true",
    GRADLE_USER_HOME: path.join(cache, "gradle"),
    // Java disables Basic for proxy tunnels by default; the proxy only speaks Basic.
    GRADLE_OPTS: [...proxy, "-Djdk.http.auth.tunneling.disabledSchemes="].join(" "),
    // Maven's client answers a proxy challenge only on its first connection, so
    // parallel downloads on new ones fail; one thread keeps them on it.
    MAVEN_ARGS: `-s ${settingsFile} -Daether.connector.basic.threads=1`,
  };
};
