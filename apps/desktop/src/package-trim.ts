import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** microsandbox's native package per target, as its `napi.targets` names them. */
const MICROSANDBOX_PACKAGE: Readonly<Record<string, string>> = {
  "darwin-arm64": "microsandbox-darwin-arm64",
  "linux-x64": "microsandbox-linux-x64-gnu",
  "linux-arm64": "microsandbox-linux-arm64-gnu",
  "win32-x64": "microsandbox-win32-x64-msvc",
  "win32-arm64": "microsandbox-win32-arm64-msvc",
};

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const entries = (directory: string) => readdir(directory).catch(() => [] as string[]);

/**
 * Leaves in a packaged app's node_modules only microsandbox's native package for its platform and
 * architecture. CI installs both architectures to cross-package, and each package carries its own
 * VM runner and kernel. Throws when the kept one is missing, so a build without it fails here
 * rather than at the first chat VM.
 */
export const trimPackage = async (
  nodeModules: string,
  platform: string,
  arch: string,
): Promise<string[]> => {
  const keep = MICROSANDBOX_PACKAGE[`${platform}-${arch}`];
  if (!keep) throw new Error(`microsandbox has no native package for ${platform}-${arch}`);
  const scope = join(nodeModules, "@superradcompany");
  const removed: string[] = [];
  for (const name of await entries(scope)) {
    if (!name.startsWith("microsandbox-") || name === keep) continue;
    await rm(join(scope, name), { recursive: true, force: true });
    removed.push(join(scope, name));
  }
  if (!(await exists(join(scope, keep))))
    throw new Error(`microsandbox's ${keep} is missing; install with --cpu ${arch}`);
  return removed;
};
