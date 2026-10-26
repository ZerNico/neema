import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/**
 * Folders whose files would hand a chat the person's identity: keys, cloud credentials, tokens.
 * A chat may not have one, or a folder holding one, whoever asks.
 */
const CREDENTIALS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".config/gcloud",
  ".config/gh",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
];

const inside = (parent: string, child: string) => {
  const rest = relative(parent, child);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
};

/**
 * The real folder a person named, or why a chat may not have it: not a folder, a disk root, the
 * home folder itself, the app's own data, or anything holding credentials. Judged by where links
 * lead, since the VM sees what the mount shows.
 */
export async function checkFolder(
  named: string,
  appData: string,
): Promise<{ path: string } | { refused: string }> {
  const home = homedir();
  const expanded = named.startsWith("~") ? join(home, named.slice(1)) : named;
  if (!isAbsolute(expanded)) return { refused: `${named} is not a full path.` };
  let path: string;
  try {
    path = await realpath(resolve(expanded));
  } catch {
    return { refused: `${named} does not exist.` };
  }
  if (!(await stat(path)).isDirectory()) return { refused: `${named} is not a folder.` };
  const realHome = await realpath(home).catch(() => home);
  const realData = await realpath(appData).catch(() => appData);
  if (path === parse(path).root) return { refused: "A whole disk cannot be given to a chat." };
  if (path === realHome || inside(path, realHome))
    return {
      refused: "The home folder as a whole cannot be given to a chat; pick a folder inside it.",
    };
  if (inside(realData, path) || inside(path, realData))
    return { refused: "The app's own data cannot be given to a chat." };
  for (const entry of CREDENTIALS) {
    const credential = join(realHome, ...entry.split("/"));
    if (inside(credential, path) || inside(path, credential))
      return {
        refused: `${named} holds credentials (${entry.split("/").join(sep)}), which no chat may have.`,
      };
  }
  return { path };
}

/** Folders the person said not to be asked about again on this machine, per server. */
export class RememberedFolders {
  private loaded: Promise<Set<string>> | undefined;

  constructor(private readonly file: string) {}

  private all() {
    return (this.loaded ??= readFile(this.file, "utf8")
      .then((text) => JSON.parse(text) as unknown)
      .then(
        (list) =>
          new Set(Array.isArray(list) ? list.filter((item) => typeof item === "string") : []),
      )
      .catch(() => new Set<string>()));
  }

  async has(path: string) {
    return (await this.all()).has(path);
  }

  async add(path: string) {
    const all = await this.all();
    all.add(path);
    await writeFile(this.file, JSON.stringify([...all]));
  }
}
