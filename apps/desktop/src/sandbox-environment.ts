import { platform } from "node:os";
import { posix, win32 } from "node:path";

/** Quote one literal shell word, not a command to evaluate. */
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const commandEnvironment = (cwd: string, os: NodeJS.Platform) => {
  const path = os === "win32" ? win32 : posix;
  const cache = path.join(cwd, ".cache");
  const variables = {
    TEMP: cwd,
    TMP: cwd,
    XDG_CACHE_HOME: cache,
    PIP_CACHE_DIR: path.join(cache, "pip"),
    UV_CACHE_DIR: path.join(cache, "uv"),
    MPLCONFIGDIR: path.join(cache, "matplotlib"),
  };
  // SRT omits POSIX TMPDIR on Windows because it breaks MSYS tools.
  return Object.entries(os === "win32" ? variables : { TMPDIR: cwd, ...variables });
};

export const commandWithEnvironment = (command: string, cwd: string, os = platform()) => {
  if (os === "win32") return command;
  // Run after SRT's own env setup, inside confinement. Libraries create their
  // caches there; host-side mkdir could follow a workspace symlink outside it.
  const exports = commandEnvironment(cwd, os).map(
    ([key, value]) => `export ${key}=${shellQuote(value)}`,
  );
  return `${exports.join("\n")}\n${command}`;
};

/** SRT's literal words may concatenate quoted and escaped pieces. Never evaluate expansions. */
const shellWord = (script: string, start: number) => {
  let value = "";
  let quote: string | null = null;
  for (let end = start; end < script.length; end += 1) {
    const char = script[end]!;
    if (!quote && /\s/.test(char)) return { value, end };
    if (char === quote) {
      quote = null;
      continue;
    }
    if (!quote && (char === "'" || char === '"')) {
      quote = char;
      continue;
    }
    if (quote !== "'" && char === "\\") {
      const next = script[end + 1];
      if (next === undefined) return null;
      if (quote === '"' && !'\\"$`\n'.includes(next)) {
        value += char;
        continue;
      }
      if (next !== "\n") value += next;
      end += 1;
      continue;
    }
    if (quote !== "'" && (char === "$" || char === "`" || (!quote && ";|&<>()*?[".includes(char))))
      return null;
    value += char;
  }
  return quote ? null : { value, end: script.length };
};

const proxyValue = (key: string, value: string) => {
  if (key === "CLOUDSDK_PROXY_ADDRESS" || key === "RSYNC_PROXY")
    return value.replace(/^localhost(?=:|$)/, "127.0.0.1");
  if (!/_proxy$/i.test(key) || /^no_proxy$/i.test(key)) return value;
  return value.replace(
    /^([a-z][a-z0-9+.-]*:\/\/(?:[^@\s]*@)?)localhost(?=:\d|\/|$)/i,
    (_match, prefix: string) => `${prefix}127.0.0.1`,
  );
};

const rewriteProxyAssignments = (script: string) => {
  if (!/^env\s/.test(script)) return script;
  let cursor = 3;
  let copied = 0;
  const parts: string[] = [];
  while (cursor < script.length) {
    while (cursor < script.length && /\s/.test(script[cursor]!)) cursor += 1;
    if (cursor === script.length) break;
    const start = cursor;
    const word = shellWord(script, start);
    if (!word) break;
    cursor = word.end;
    if (word.value === "-u") {
      while (cursor < script.length && /\s/.test(script[cursor]!)) cursor += 1;
      const name = shellWord(script, cursor);
      if (!name || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(name.value)) break;
      cursor = name.end;
      continue;
    }
    if (word.value === "--") continue;
    const assignment = /^([A-Za-z_][A-Za-z_0-9]*)=([\s\S]*)$/.exec(word.value);
    if (!assignment) break;
    const key = assignment[1]!;
    const value = assignment[2]!;
    const rewritten = proxyValue(key, value);
    if (rewritten === value) continue;
    parts.push(script.slice(copied, start), shellQuote(`${key}=${rewritten}`));
    copied = cursor;
  }
  return parts.join("") + script.slice(copied);
};

export const forSandboxedChild = (
  argv: readonly string[],
  cwd: string,
  os = platform(),
): string[] => {
  if (os === "win32") {
    // The Windows child starts with the sandbox user's env, not the broker's.
    // SRT's --env overlay before -- is the only path into that child.
    const boundary = argv.indexOf("--");
    if (boundary < 1) throw new Error("The Windows sandbox command has no argument boundary.");
    const variables = new Map(commandEnvironment(cwd, os));
    const prefix: string[] = [];
    for (let index = 0; index < boundary; index += 1) {
      const arg = argv[index]!;
      if (arg === "--env" && index + 1 < boundary) {
        const entry = argv[index + 1]!;
        if (variables.has(entry.slice(0, entry.indexOf("=")).toUpperCase())) {
          index += 1;
          continue;
        }
      }
      prefix.push(arg);
    }
    return [
      ...prefix,
      ...[...variables].flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      ...argv.slice(boundary),
    ];
  }
  // Seatbelt blocks localhost resolution. Only macOS needs this rewrite;
  // bwrap's network namespace and Windows' broker have different proxy routing.
  return argv.map((arg, index) =>
    os === "darwin" && index === 2 && argv[1] === "-c" ? rewriteProxyAssignments(arg) : arg,
  );
};
