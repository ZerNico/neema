import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

const serverDirectory = resolve(".output/server");

const findModules = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedModules = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return findModules(path);
      if (entry.isFile() && entry.name.endsWith(".mjs")) return [path];
      return [];
    }),
  );

  return nestedModules.flat();
};

let modules;
try {
  modules = (await findModules(serverDirectory)).toSorted();
} catch (error) {
  console.error(`Could not inspect ${relative(process.cwd(), serverDirectory)}.`);
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

if (modules.length === 0) {
  console.error("No production server modules were emitted.");
  process.exit(1);
}

for (const modulePath of modules) {
  try {
    execFileSync(process.execPath, ["--check", modulePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    console.error(`Invalid server module: ${relative(process.cwd(), modulePath)}`);
    if (error && typeof error === "object" && "stderr" in error) {
      console.error(String(error.stderr).trim());
    } else {
      console.error(error);
    }
    process.exit(1);
  }
}

console.log(`Checked ${modules.length} production server modules.`);
