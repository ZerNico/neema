import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import electron from "electron";

const NAME = "neema";

/**
 * The shell runs unpackaged, and macOS takes the Dock, Cmd-Tab and menu bar
 * name from the running bundle's Info.plist, not from `app.setName`. So on
 * macOS we launch a renamed copy of Electron.app, made once per Electron
 * version. Changing the plist voids the signature, hence the ad-hoc re-sign.
 */
export const electronBinary = () => {
  if (process.platform !== "darwin") return electron;
  const source = join(dirname(electron), "..", "..");
  const version = readFileSync(join(source, "..", "version"), "utf8").trim();
  const bundle = join(import.meta.dirname, "node_modules", ".cache", "electron-app", `${NAME}.app`);
  const binary = join(bundle, "Contents", "MacOS", "Electron");
  const marker = join(bundle, "..", "version");
  if (existsSync(binary) && existsSync(marker) && readFileSync(marker, "utf8").trim() === version)
    return binary;

  rmSync(dirname(bundle), { recursive: true, force: true });
  mkdirSync(dirname(bundle), { recursive: true });
  try {
    // A copy-on-write clone on APFS; a plain copy elsewhere.
    execFileSync("cp", ["-Rc", source, bundle]);
  } catch {
    rmSync(bundle, { recursive: true, force: true });
    execFileSync("cp", ["-R", source, bundle]);
  }
  const plist = join(bundle, "Contents", "Info.plist");
  for (const key of ["CFBundleName", "CFBundleDisplayName"])
    execFileSync("plutil", ["-replace", key, "-string", NAME, plist]);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "ignore" });
  writeFileSync(marker, version);
  return binary;
};

// Run directly (`pnpm start`): launch the built shell once.
if (import.meta.main) {
  const child = spawn(electronBinary(), ["dist/main.cjs"], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
  child.on("exit", (code) => process.exit(code ?? 1));
}
