import { execFile } from "node:child_process";
import { createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import {
  checkWindowsDependenciesAsync,
  getWindowsSandboxUserStatusAsync,
  installWindowsSandboxAsync,
  resolveSrtWin,
  VENDORED_SRT_WIN_EXE,
} from "@anthropic-ai/sandbox-runtime";
import { Semaphore } from "effect";

// Profiles and dev shells share the native sandbox account, not just this manager.
const HOST_PIPE = "\\\\.\\pipe\\neema-sandbox-owner";
const broker = () => resolveSrtWin({ path: VENDORED_SRT_WIN_EXE });
const icacls = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
const run = promisify(execFile);

/**
 * Profile folders above an attached root, which SRT grants nothing on. The sandbox
 * account has no rights in a profile, and Node stats every ancestor of a script.
 */
export const profileAncestors = (roots: ReadonlyArray<string>, home: string) => {
  const folders = new Set<string>();
  for (const root of roots) {
    const rest = relative(home, root);
    if (rest === "" || rest.startsWith("..") || isAbsolute(rest)) continue;
    for (let folder = dirname(root); ; folder = dirname(folder)) {
      folders.add(folder);
      if (relative(home, folder) === "") break;
    }
  }
  return [...folders];
};

export const makeWindowsSandbox = (pipe = HOST_PIPE) => {
  const permit = Semaphore.makeUnsafe(1);
  let failure: Error | null = null;
  let host: Server | undefined;

  return {
    permit,
    config: { srtWin: { path: VENDORED_SRT_WIN_EXE } },
    get failure() {
      return failure;
    },
    block(cause: unknown) {
      failure ??= new Error(`Sandbox cleanup could not be confirmed: ${String(cause)}`);
    },
    check: () => checkWindowsDependenciesAsync({ srtWin: broker() }),
    install: () => installWindowsSandboxAsync({ srtWin: broker() }),
    /**
     * Read attributes alone, not inherited: it lists nothing and opens no file, so it
     * stays in place instead of joining SRT's checked cleanup.
     */
    async allowTraversal(roots: ReadonlyArray<string>) {
      const folders = profileAncestors(roots, homedir());
      if (folders.length === 0) return;
      const { sid } = await getWindowsSandboxUserStatusAsync({ srtWin: broker() });
      if (!sid) throw new Error("The sandbox account is not provisioned.");
      for (const folder of folders) {
        // Rewriting a profile's ACL re-propagates the whole tree, seconds each time.
        const { stdout } = await run(icacls, [folder, "/findsid", `*${sid}`]);
        if (!stdout.includes(folder)) await run(icacls, [folder, "/grant", `*${sid}:(RA)`]);
      }
    },
    async claimHost() {
      if (failure) throw failure;
      const server = createServer((socket) => socket.destroy());
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(pipe, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      host = server;
      server.on("error", (cause) => {
        failure ??= cause;
      });
      server.unref();
      return async () => {
        // Retain ownership on uncertainty. Setup or another service cannot clear it.
        if (failure) return;
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              failure ??= error;
              reject(error);
            } else resolve();
          });
        });
        if (host === server) host = undefined;
      };
    },
  };
};

export const windowsSandbox = makeWindowsSandbox();
