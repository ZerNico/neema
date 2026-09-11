import { Effect } from "effect";
import { assertPublicHttpUrl } from "~/modules/tools/server/url-safety.ts";
import {
  decodeSkillText,
  SKILL_LIMITS,
  SkillPackageError,
  type SkillFinding,
  validateSkillPackage,
  validateSkillPath,
  type SkillFile,
  type ValidatedSkillPackage,
} from "../package.ts";
import type { SkillSource } from "~/db/schema/skills.ts";
import { skillContentHash } from "./content-hash.ts";
import { DISCOVERY_MAX, DISCOVERY_PAGE } from "../schema.ts";

export interface DiscoveredSkill {
  name: string;
  source: string;
  skillId: string;
  installs: number;
}
export interface DiscoveryPage {
  skills: DiscoveredSkill[];
  /** Rows the endpoint returned, before unaddressable ones were dropped. */
  received: number;
}
export interface RemoteSkillPackage {
  package: ValidatedSkillPackage;
  source: SkillSource;
}
export interface GitHubPackageChoice {
  path: string;
  name: string;
  description: string;
}
export interface GitHubReview {
  repository: string;
  commit: string;
  choices: GitHubPackageChoice[];
  selected: RemoteSkillPackage | null;
}
export class SkillRemoteError extends Error {}
/**
 * Real ids carry colons and ampersands (`react:components`, `pdf-merge-&-split`),
 * so the rule is what makes an id addressable rather than a guessed alphabet:
 * one path segment, no separators, no control characters, not a dot segment.
 */
// oxlint-disable-next-line no-control-regex -- excluding control characters is the point
const skillIdPattern = /^(?!\.{1,2}$)[^/\\\u0000-\u001f\u007f]{1,128}$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const shaPattern = /^[0-9a-f]{40}$/u;
const allowedHosts = new Set(["skills.sh", "api.github.com", "raw.githubusercontent.com"]);
const object = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new SkillRemoteError("Upstream returned an invalid response.");
  return input as Record<string, unknown>;
};

/** Fixed hosts plus the existing DNS/redirect SSRF guard. No credentials or ambient authorization. */
export async function fetchSkillBytes(
  rawUrl: string,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const timeout = AbortSignal.timeout(15_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let current = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    // Cancellation has to be observed here: an aborted caller must not reach
    // the network at all, and each redirect hop is its own request.
    combined.throwIfAborted();
    const parsed = new URL(current);
    if (parsed.protocol !== "https:" || parsed.port || !allowedHosts.has(parsed.hostname))
      throw new SkillRemoteError("Unsupported upstream host.");
    await Effect.runPromise(assertPublicHttpUrl(current), { signal: combined });
    const response = await fetch(current, {
      signal: combined,
      redirect: "manual",
      credentials: "omit",
      headers: {
        Accept:
          parsed.hostname === "api.github.com"
            ? "application/vnd.github+json"
            : "application/json, text/plain",
        "User-Agent": "portable-skills",
      },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new SkillRemoteError("Upstream returned a redirect without a location.");
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SkillRemoteError(
        response.status === 429 || response.status === 403
          ? "Upstream rate limit reached. Try again later or upload a file."
          : "Upstream service is unavailable. URL and file imports remain independent of discovery.",
      );
    }
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel();
      throw new SkillRemoteError("Upstream response exceeds the size limit.");
    }
    if (!response.body) throw new SkillRemoteError("Upstream returned no body.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > limit) throw new SkillRemoteError("Upstream response exceeds the size limit.");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
  throw new SkillRemoteError("Too many upstream redirects.");
}
const json = async (
  url: string,
  limit: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> =>
  object(JSON.parse(decodeSkillText(await fetchSkillBytes(url, limit, signal), "upstream.json")));

export function parseDiscoveryResponse(value: unknown): DiscoveryPage {
  const response = object(value);
  if (!Array.isArray(response.skills))
    throw new SkillRemoteError("Discovery returned an unsupported response.");
  const skills: DiscoveredSkill[] = [];
  const received = Math.min(response.skills.length, DISCOVERY_MAX);
  // A row we cannot address is skipped, not fatal: one unusual entry must not
  // take the whole result set down with it.
  for (const input of response.skills.slice(0, DISCOVERY_MAX)) {
    const row = object(input);
    if (
      typeof row.name === "string" &&
      row.name &&
      row.name.length <= 128 &&
      typeof row.source === "string" &&
      repositoryPattern.test(row.source) &&
      typeof row.skillId === "string" &&
      skillIdPattern.test(row.skillId) &&
      typeof row.installs === "number" &&
      Number.isSafeInteger(row.installs) &&
      row.installs >= 0
    )
      skills.push({
        name: row.name,
        source: row.source,
        skillId: row.skillId,
        installs: row.installs,
      });
  }
  return { skills, received };
}

const discoveryCache = new Map<string, { until: number; page: DiscoveryPage }>();
const windows = new Map<string, { until: number; count: number }>();
function admitSkillRemote(userId: string): void {
  const now = Date.now();
  for (const [key, value] of windows) if (value.until <= now) windows.delete(key);
  const window = windows.get(userId);
  if ((window?.count ?? 0) >= 30 || (!window && windows.size >= 10_000))
    throw new SkillRemoteError("Too many skill requests. Try again in a minute.");
  windows.set(userId, { until: window?.until ?? now + 60_000, count: (window?.count ?? 0) + 1 });
}
export async function discoverSkills(
  userId: string,
  query: string,
  limit = DISCOVERY_PAGE,
  signal?: AbortSignal,
): Promise<DiscoveryPage> {
  const q = query.trim();
  if (!q) return { skills: [], received: 0 };
  if (q.length > 200) throw new SkillRemoteError("Search must be at most 200 characters.");
  const size = Math.min(Math.max(Math.trunc(limit) || DISCOVERY_PAGE, 1), DISCOVERY_MAX);
  admitSkillRemote(userId);
  const key = `${size}:${q}`;
  const cached = discoveryCache.get(key);
  if (cached && cached.until > Date.now()) return cached.page;
  const page = parseDiscoveryResponse(
    await json(
      `https://skills.sh/api/search?q=${encodeURIComponent(q)}&limit=${size}`,
      512 * 1024,
      signal,
    ),
  );
  if (discoveryCache.size >= 100) discoveryCache.delete(discoveryCache.keys().next().value!);
  discoveryCache.set(key, { until: Date.now() + 60_000, page });
  return page;
}

export function parseSkillUrl(raw: string): {
  repository: string;
  ref: string | null;
  path: string | null;
  skillId: string | null;
} {
  let url: URL;
  // WHATWG URL parsing removes dot segments and normalizes backslashes. Reject
  // those spellings before parsing so the reviewed target is never silently changed.
  try {
    const rawPath = raw.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+/u, "").split(/[?#]/u)[0]!;
    if (
      raw.includes("\\") ||
      rawPath.split("/").some((part) => {
        const decoded = decodeURIComponent(part);
        return (
          decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")
        );
      })
    )
      throw new Error("Ambiguous path");
  } catch {
    throw new SkillRemoteError(
      "Use a canonical URL without dot segments or encoded path separators.",
    );
  }
  try {
    url = new URL(raw);
  } catch {
    throw new SkillRemoteError(
      "Enter a GitHub repository/tree or GitHub-backed skills.sh listing URL.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new SkillRemoteError("Use a canonical HTTPS URL without credentials, query or fragment.");
  const segments = url.pathname.replace(/\/$/u, "").slice(1).split("/").map(decodeURIComponent);
  const repository = segments.slice(0, 2).join("/");
  if (!repositoryPattern.test(repository)) throw new SkillRemoteError("Invalid GitHub repository.");
  if (url.hostname === "skills.sh" && segments.length === 3 && skillIdPattern.test(segments[2]!))
    return { repository, ref: null, path: null, skillId: segments[2]! };
  if (url.hostname !== "github.com")
    throw new SkillRemoteError(
      "Only GitHub repositories and GitHub-backed skills.sh listings are supported.",
    );
  if (segments.length === 2) return { repository, ref: null, path: null, skillId: null };
  if (segments[2] !== "tree" || !segments[3])
    throw new SkillRemoteError("Use a GitHub repository or tree URL.");
  // Keep the first segment provisional; review resolves the longest actual branch/tag.
  const path = segments.slice(4).join("/");
  if (path) validateSkillPath(path);
  return { repository, ref: segments[3], path: path || null, skillId: null };
}

export async function reviewGitHubSkill(
  userId: string,
  rawUrl: string,
  chosenPath?: string,
  signal?: AbortSignal,
): Promise<GitHubReview> {
  admitSkillRemote(userId);
  signal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(90_000)])
    : AbortSignal.timeout(90_000);
  const input = parseSkillUrl(rawUrl);
  const base = `https://api.github.com/repos/${input.repository}`;
  if (input.ref && !shaPattern.test(input.ref)) {
    // Resolve the longest real ref instead of guessing where a slash-bearing branch ends.
    const rest = [input.ref, ...(input.path ? [input.path] : [])].join("/");
    const matches: string[] = [];
    for (const family of ["heads", "tags"]) {
      const refs: unknown = JSON.parse(
        decodeSkillText(
          await fetchSkillBytes(
            `${base}/git/matching-refs/${family}/${encodeURIComponent(input.ref)}`,
            512 * 1024,
            signal,
          ),
          "refs.json",
        ),
      );
      if (!Array.isArray(refs) || refs.length > 200)
        throw new SkillRemoteError("Too many matching refs. Use an immutable commit URL.");
      for (const value of refs) {
        const name = object(value).ref;
        if (typeof name !== "string" || !name.startsWith(`refs/${family}/`))
          throw new SkillRemoteError("Invalid GitHub ref response.");
        const ref = name.slice(`refs/${family}/`.length);
        if (rest === ref || rest.startsWith(`${ref}/`)) matches.push(ref);
      }
    }
    const ref = [...matches].sort((a, b) => b.length - a.length)[0];
    if (!ref)
      throw new SkillRemoteError(
        "Could not resolve the branch or tag. Use an immutable commit URL.",
      );
    input.ref = ref;
    input.path = rest.slice(ref.length).replace(/^\//u, "") || null;
  }
  const commitResponse = await json(
    `${base}/commits/${encodeURIComponent(input.ref ?? "HEAD")}`,
    512 * 1024,
    signal,
  );
  if (typeof commitResponse.sha !== "string" || !shaPattern.test(commitResponse.sha))
    throw new SkillRemoteError("GitHub did not resolve an immutable commit.");
  const commit = commitResponse.sha;
  // A known package path reads only that subtree. Whole-repository trees for
  // collections like anthropics/skills run to megabytes of JSON, and the
  // package being imported is a few files inside one directory of it.
  const prefixPath = chosenPath ?? input.path;
  const treeResponse = await json(
    prefixPath
      ? `${base}/git/trees/${encodeURIComponent(`${commit}:${prefixPath}`)}?recursive=1`
      : `${base}/git/trees/${commit}?recursive=1`,
    4 * 1024 * 1024,
    signal,
  );
  if (
    treeResponse.truncated ||
    !Array.isArray(treeResponse.tree) ||
    treeResponse.tree.length > 10_000
  )
    throw new SkillRemoteError(
      prefixPath
        ? "Package is too large to import."
        : "Repository is too large for bounded discovery. Link the package directory directly.",
    );
  const entries = treeResponse.tree.map((item) => {
    const row = object(item);
    if (
      typeof row.path !== "string" ||
      typeof row.type !== "string" ||
      typeof row.mode !== "string"
    )
      throw new SkillRemoteError("Invalid GitHub tree entry.");
    return {
      path: prefixPath ? `${prefixPath}/${row.path}` : row.path,
      type: row.type,
      mode: row.mode,
      size: row.size,
    };
  });
  const candidates = entries.filter(
    (entry) =>
      entry.type === "blob" &&
      (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md")) &&
      (!input.path ||
        entry.path === `${input.path}/SKILL.md` ||
        entry.path.startsWith(`${input.path}/`)),
  );
  // A listing names one skill, and collections like anthropics/skills hold far
  // more than the scan cap. Narrow to the directory that carries that name
  // before deciding the repository is too broad to search.
  const named = input.skillId
    ? candidates.filter(
        (entry) =>
          entry.path === `${input.skillId}/SKILL.md` ||
          entry.path.endsWith(`/${input.skillId}/SKILL.md`),
      )
    : [];
  const scoped = named.length ? named : candidates;
  if (scoped.length > 40)
    throw new SkillRemoteError("Too many package roots. Use a direct GitHub tree URL.");
  const readPath = (path: string, limit: number) =>
    fetchSkillBytes(
      `https://raw.githubusercontent.com/${input.repository}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`,
      limit,
      signal,
    );
  const choices: GitHubPackageChoice[] = [];
  const roots = new Map<string, SkillFile>();
  for (const candidate of scoped) {
    if (candidate.mode !== "100644" && candidate.mode !== "100755")
      throw new SkillRemoteError("Linked SKILL.md files are unsupported.");
    const content = decodeSkillText(
      await readPath(candidate.path, SKILL_LIMITS.rootBytes),
      candidate.path,
    );
    const parsed = validateSkillPackage([{ path: "SKILL.md", content }]);
    const path = candidate.path.slice(0, -"SKILL.md".length).replace(/\/$/u, "");
    if (
      input.skillId &&
      parsed.metadata.name !== input.skillId &&
      path !== input.skillId &&
      !path.endsWith(`/${input.skillId}`)
    )
      continue;
    choices.push({ path, name: parsed.metadata.name, description: parsed.metadata.description });
    roots.set(path, { path: "SKILL.md", content });
  }
  if (!choices.length)
    throw new SkillRemoteError("No matching valid SKILL.md package found in this repository.");
  const selectedPath = chosenPath ?? (choices.length === 1 ? choices[0]!.path : undefined);
  if (selectedPath === undefined)
    return { repository: input.repository, commit, choices, selected: null };
  if (!roots.has(selectedPath))
    throw new SkillRemoteError("Select one of the discovered package roots.");
  const prefix = selectedPath ? `${selectedPath}/` : "";
  const selected = entries.filter(
    (entry) => entry.path.startsWith(prefix) && entry.type !== "tree",
  );
  if (selected.length > SKILL_LIMITS.files)
    throw new SkillRemoteError("Package exceeds 100 files.");
  const files: SkillFile[] = [];
  const invalidFiles: SkillFinding[] = [];
  let total = 0;
  for (const entry of selected) {
    const path = entry.path.slice(prefix.length);
    validateSkillPath(path);
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755"))
      throw new SkillRemoteError(`Unsupported symlink/submodule: ${path}`);
    const bytes = await readPath(
      entry.path,
      path === "SKILL.md" ? SKILL_LIMITS.rootBytes : SKILL_LIMITS.fileBytes,
    );
    total += bytes.length;
    if (total > SKILL_LIMITS.expandedBytes) throw new SkillRemoteError("Package exceeds 10 MiB.");
    try {
      files.push({ path, content: decodeSkillText(bytes, path) });
    } catch (error) {
      if (error instanceof SkillPackageError) invalidFiles.push(...error.findings);
      else throw error;
    }
  }
  if (invalidFiles.length) throw new SkillPackageError(invalidFiles);
  const validated = validateSkillPackage(files);
  return {
    repository: input.repository,
    commit,
    choices,
    selected: {
      package: validated,
      source: {
        url: rawUrl,
        repository: input.repository,
        commit,
        path: selectedPath,
        contentHash: skillContentHash(validated.files),
      },
    },
  };
}
