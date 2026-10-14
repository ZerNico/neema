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
  const inherited = Object.entries(parent)
    .filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && CHILD_ENVIRONMENT.has(entry[0].toUpperCase()),
    )
    // Windows spells it Path; one PATH key keeps a later PATH from shadowing it with a second.
    .map(([name, value]): [string, string] =>
      os === "win32" && name.toUpperCase() === "PATH" ? ["PATH", value] : [name, value],
    );
  return {
    ...Object.fromEntries(inherited),
    // MXC gives a Windows container its own TEMP and TMP, where files OpenSSH writes are
    // unreadable to git (signing fails); Git for Windows reads TMPDIR first.
    TEMP: cwd,
    TMP: cwd,
    TMPDIR: cwd,
    XDG_CACHE_HOME: cache,
    // clang and swiftc otherwise keep modules in macOS's per-user cache, which is read-only.
    CLANG_MODULE_CACHE_PATH: path.join(cache, "clang"),
    npm_config_cache: path.join(cache, "npm"),
    PIP_CACHE_DIR: path.join(cache, "pip"),
    UV_CACHE_DIR: path.join(cache, "uv"),
    MPLCONFIGDIR: path.join(cache, "matplotlib"),
    ...(os === "win32" ? WINDOWS_GIT : {}),
    ...proxy,
  };
};

/**
 * Git for Windows checks revocation through Schannel, which fetches CRLs
 * directly and never through the proxy, so every HTTPS remote fails. OpenSSL
 * skips that. Its default credential helper is a shell script, and MSYS shells
 * cannot start in the container; commands get no stored credentials anyway.
 */
const WINDOWS_GIT = {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "http.sslBackend",
  GIT_CONFIG_VALUE_0: "openssl",
  GIT_CONFIG_KEY_1: "credential.helper",
  GIT_CONFIG_VALUE_1: "",
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
  // A command's own port (Linux) takes no credentials.
  const credentials = url.username
    ? `<username>${escapeXml(decodeURIComponent(url.username))}</username>` +
      `<password>${escapeXml(decodeURIComponent(url.password))}</password>`
    : "";
  const proxy = (protocol: string) =>
    `<proxy><id>egress-${protocol}</id><active>true</active><protocol>${protocol}</protocol>` +
    `<host>${escapeXml(url.hostname)}</host><port>${url.port}</port>${credentials}</proxy>`;
  return (
    `<settings><localRepository>${escapeXml(repository)}</localRepository>` +
    `<proxies>${proxy("https")}${proxy("http")}</proxies></settings>`
  );
};

/**
 * The JVM's proxy settings, token included. They go to Gradle in an argument
 * file named in GRADLE_OPTS: as plain options they would sit in the JVM's
 * process arguments, which other processes can list.
 */
export const jvmProxyArguments = (proxyUrl: string) => {
  const url = new URL(proxyUrl);
  return [
    ...["https", "http"].flatMap((scheme) => [
      `-D${scheme}.proxyHost=${url.hostname}`,
      `-D${scheme}.proxyPort=${url.port}`,
      // A command's own port (Linux) takes no credentials.
      ...(url.username
        ? [
            `-D${scheme}.proxyUser=${decodeURIComponent(url.username)}`,
            `-D${scheme}.proxyPassword=${decodeURIComponent(url.password)}`,
          ]
        : []),
    ]),
    // Java disables Basic for proxy tunnels by default; the proxy only speaks Basic.
    "-Djdk.http.auth.tunneling.disabledSchemes=",
  ];
};

/**
 * Java ignores the proxy variables. Gradle reads its proxy from the argument
 * file and passes it on to its daemon; JAVA_TOOL_OPTIONS would print it on
 * every JVM start, so it carries only the IPv4 switch Seatbelt's loopback
 * rules need. Maven gets its settings file by path.
 */
export const jvmEnvironment = (
  cache: string,
  settingsFile: string,
  gradleArguments: string,
  os = platform(),
): Record<string, string> => {
  const path = os === "win32" ? win32 : posix;
  // cmd keeps the quotes for java and mvn.cmd; the POSIX scripts split on spaces whatever the
  // quoting, and the command folders there (/tmp, /private/tmp) have none.
  const argument = (value: string) => (os === "win32" ? `"${value}"` : value);
  return {
    JAVA_TOOL_OPTIONS: "-Djava.net.preferIPv4Stack=true",
    GRADLE_USER_HOME: path.join(cache, "gradle"),
    GRADLE_OPTS: argument(`@${gradleArguments}`),
    // Maven's client answers a proxy challenge only on its first connection, so
    // parallel downloads on new ones fail; one thread keeps them on it.
    MAVEN_ARGS: `-s ${argument(settingsFile)} -Daether.connector.basic.threads=1`,
  };
};
