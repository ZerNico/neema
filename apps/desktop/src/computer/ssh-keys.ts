import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * How many keys the agent holds, asked in its own protocol (REQUEST_IDENTITIES, answered by
 * IDENTITIES_ANSWER with a count first). Null when it does not answer. A socket or a Windows pipe.
 */
export const agentKeyCount = (socket: string, timeoutMs = 2_000) =>
  new Promise<number | null>((resolve) => {
    const connection = createConnection(socket);
    let received = Buffer.alloc(0);
    const done = (count: number | null) => {
      connection.destroy();
      resolve(count);
    };
    connection.setTimeout(timeoutMs, () => done(null));
    connection.on("error", () => done(null));
    connection.on("connect", () => connection.write(Buffer.from([0, 0, 0, 1, 11])));
    connection.on("data", (chunk) => {
      received = Buffer.concat([received, Buffer.from(chunk)]);
      if (received.length >= 9) done(received[4] === 12 ? received.readUInt32BE(5) : null);
    });
  });

/** The key `ssh` itself would try first, by OpenSSH's default names. */
export const defaultKey = async (home = homedir()) => {
  for (const name of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
    const path = join(home, ".ssh", name);
    if (await access(path).then(
      () => true,
      () => false,
    ))
      return path;
  }
  return null;
};

/**
 * Asks for a passphrase in a native dialog, since `ssh-add` has no terminal here. The prompt
 * comes from the app, in the person's language, not from `ssh-add`.
 */
const MAC_ASKPASS = `#!/bin/sh
exec /usr/bin/osascript -e 'display dialog (system attribute "NEEMA_ASKPASS_PROMPT") default answer "" with hidden answer with title "neema"' -e 'text returned of result'
`;

/**
 * Adds a key to the person's own agent with `ssh-add`, so the key file never passes through
 * this app. On macOS the passphrase is asked natively and kept in the Keychain, as
 * `--apple-use-keychain` does in a terminal. Elsewhere only a key without one is added.
 */
export const addKey = async (
  socket: string,
  key: string,
  passphrasePrompt: string,
  platform: NodeJS.Platform = process.platform,
) => {
  const env: NodeJS.ProcessEnv = { ...process.env, SSH_AUTH_SOCK: socket };
  const args = [key];
  let askpass: string | null = null;
  if (platform === "darwin") {
    askpass = await mkdtemp(join(tmpdir(), "neema-askpass-"));
    const script = join(askpass, "askpass");
    await writeFile(script, MAC_ASKPASS, { mode: 0o700 });
    Object.assign(env, {
      SSH_ASKPASS: script,
      SSH_ASKPASS_REQUIRE: "force",
      NEEMA_ASKPASS_PROMPT: passphrasePrompt,
    });
    args.unshift("--apple-use-keychain");
  } else env.SSH_ASKPASS_REQUIRE = "never";
  try {
    return await new Promise<boolean>((resolve) => {
      execFile("ssh-add", args, { env, timeout: 120_000 }, (error) => resolve(!error));
    });
  } finally {
    if (askpass) await rm(askpass, { recursive: true, force: true });
  }
};

/** What the person runs instead when the app could not add the key. */
export const addKeyCommand = (key: string, platform: NodeJS.Platform = process.platform) => {
  const shown = key.startsWith(homedir()) ? `~${key.slice(homedir().length)}` : key;
  return platform === "darwin" ? `ssh-add --apple-use-keychain ${shown}` : `ssh-add ${shown}`;
};
