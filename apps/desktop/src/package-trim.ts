import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * The one native library MXC loads per platform. Every backend this app uses
 * (Seatbelt, bubblewrap, the Windows process container) runs in process
 * through it; the executors and daemons beside it serve other backends.
 */
const MXC_LIBRARY: Readonly<Record<string, string>> = {
  darwin: "libmxc_ffi.dylib",
  linux: "libmxc_ffi.so",
  win32: "mxc_ffi.dll",
};

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const entries = (directory: string) => readdir(directory).catch(() => [] as string[]);

/**
 * Leaves in a packaged app's node_modules only what runs on its platform and
 * architecture: MXC's library for it, koffi's binding for it, and no node-pty,
 * which MXC loads only for terminal sessions this app never opens. Throws when
 * a kept file is missing, so a dependency that moved fails the build rather
 * than the first command.
 */
export const trimPackage = async (
  nodeModules: string,
  platform: string,
  arch: string,
): Promise<string[]> => {
  const library = MXC_LIBRARY[platform];
  if (!library) throw new Error(`No MXC library is known for ${platform}`);
  const removed: string[] = [];
  const remove = async (path: string) => {
    await rm(path, { recursive: true, force: true });
    removed.push(path);
  };

  const bin = join(nodeModules, "@microsoft", "mxc-sdk", "bin");
  for (const folder of await entries(bin)) {
    if (folder !== arch) {
      await remove(join(bin, folder));
      continue;
    }
    for (const file of await entries(join(bin, folder)))
      if (file !== library) await remove(join(bin, folder, file));
  }
  const kept = join(bin, arch, library);
  if (!(await exists(kept))) throw new Error(`MXC's ${library} for ${arch} is missing: ${kept}`);

  const koffi = join(nodeModules, "@koromix");
  const binding = `koffi-${platform}-${arch}`;
  for (const name of await entries(koffi)) if (name !== binding) await remove(join(koffi, name));
  if (!(await exists(join(koffi, binding))))
    throw new Error(
      `koffi's binding for ${platform}-${arch} is missing; install with --cpu ${arch}`,
    );

  // node-addon-api only builds node-pty.
  for (const name of ["node-pty", "node-addon-api"])
    if (await exists(join(nodeModules, name))) await remove(join(nodeModules, name));
  return removed;
};
