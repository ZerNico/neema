import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The one server this shell talks to, chosen on first run.
 *
 * It is a security boundary, not a convenience. The bridge is exposed only to
 * this origin, so pointing the shell somewhere is the act that grants a site
 * the ability to ask about files. Changing it is therefore a deliberate step,
 * never something a page can do to itself.
 */
export interface DesktopConfig {
  readonly serverUrl: string;
}

export const configFile = (userData: string) => join(userData, "server.json");

/** True when the OS may open this URL: http(s) pages only, never file: or a scheme. */
export const isSafeExternalUrl = (input: string): boolean => {
  try {
    const url = new URL(input);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

/** True when `url` is a page of the configured server, not recovery or connect. */
export const isConfiguredOriginUrl = (url: string, origin: string | null): boolean =>
  origin !== null && toOrigin(url) === origin;

/** Normalised to an origin: a stored path or query would weaken every later comparison. */
export const toOrigin = (input: string): string | null => {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  // Anything already carrying a scheme is parsed as written, so `file://` and
  // friends reach the protocol check below instead of being prefixed into a
  // plausible-looking origin. Bare input is assumed https, and `localhost:3000`
  // stays a host and port rather than becoming a scheme.
  const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
};

/**
 * Whether the bridge may be handed to this origin: https, or http on this
 * machine. Anyone on the network path of a plain-http server could inject the
 * script that drives commands and files.
 */
export const bridgeableOrigin = (origin: string): boolean => {
  const url = new URL(origin);
  if (url.protocol === "https:") return true;
  const host = url.hostname;
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
};

export const readConfig = async (file: string): Promise<DesktopConfig | null> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const url = (parsed as { serverUrl?: unknown }).serverUrl;
    if (typeof url !== "string") return null;
    const origin = toOrigin(url);
    return origin === null ? null : { serverUrl: origin };
  } catch {
    return null;
  }
};

export const writeConfig = async (file: string, config: DesktopConfig): Promise<void> => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(config, null, 2), "utf8");
};
