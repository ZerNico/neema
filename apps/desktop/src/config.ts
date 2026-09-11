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
