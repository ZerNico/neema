# Portable skills

A skill is a SKILL.md package (`src/modules/skills`), not a permission and not a tool. Nothing in a package ever executes.

## Storage and lifecycle

- The raw document is the ONLY metadata source: name/description are parsed from its frontmatter, so there is no competing metadata form state. Unsupported directives (hooks, `context: fork`, shell substitutions) are flagged once on SKILL.md; script files are kept as ordinary text without a per-file warning, since the editor already says scripts are never run.
- Revisions are immutable; files live in the existing BlobStore/`attachment_blobs` registry with candidate/orphan cleanup intents, deduplicated per user by SHA. `collectUnused` runs two passes (superseded local revisions, then their newly unreferenced baselines) and retains anything a `message_skills` row or another revision's baseline pointer references.
- Soft deletion blocks new attempts while history stays readable and blobs stay put; reclamation currently triggers only on a skill save or removal, not on history deletion.
- An imported upstream baseline is stored as a **negative** `skill_revisions.revision` ordinal on the same skill, sharing the immutable file lifecycle but never exposed through any public API. An update applies the fetched upstream as the new baseline even when the owner keeps local choices, so the next three-way comparison (`update.ts`, whole-file only, no text merge) stays honest.
- `SkillReader` is a private execution-only service; owner detail/export/baseline reads live in `SkillService`. Recipients get safe metadata plus invocation, never bodies or the editor API, because instructions can't be kept secret from someone who can use the skill (the editor says so).

## Access and authorization

- Every new attempt (send, retry, edit, structured answer, research continuation, branch) resolves current revisions and ACLs inside the attempt transaction, before any destructive reset. Original standalone IDs stay separate from agent dependencies, including overlaps, so removing a skill from an agent leaves an explicit selection intact.
- Active attempts pin content but recheck access: losing it is sticky and terminal, never a recoverable failed tool result.
- `SkillRepo.catalogue` adds every readable, non-manual-only skill as an `ambient` manifest entry at dispatch (chat and research alike), on top of the attempt's pinned selections. Ambient entries are metadata-only offers, not authorized as attempt dependencies, so losing access to one never fails a turn, while `readPinned` still checks access per read. The prompt says the descriptions are all the model has and to call `load_skill` when one matches; without that instruction a listed skill simply never gets used.
- An agent's own skills sit between the two tiers: offered on demand like an ambient entry, authorized like a pinned one, marked `forThisAgent` in the catalogue with a prompt line telling the model to prefer them. Without that marking an agent's skills are indistinguishable from everything else the reader owns, which made attaching one a near no-op that only converted "silently not offered" into a hard turn failure.
- Attaching a skill to an agent is a preference, never a pin: it changes what is offered, not what is authorized ahead of time.
- Manual-only means "never offered on its own", not "unusable". The ambient query excludes those at the source, so a deliberate selection or an agent attachment is the only way to reach one; filtering the catalogue on `explicit` alone left an agent's manual-only skill authorized, able to fail the turn, and silently absent from the list. The catalogue filter keys off `ambient`.

## Runtime bounds

- `load_skill`/`read_skill_file` are bounded (20 catalogue entries, 5 loaded, 32 shared operations, 2 concurrent reads, exact UTF-16 continuations). Roots enter protected context once and are never duplicated into tool output; required instructions that don't fit are refused, never truncated.
- Research workers share one session, budget and semaphore for `load_skill`/`read_skill_file` across all tasks in a run.
- `projectSkillToolResult` is the only path to durable rows and SSE, and every displayed field is length-bounded (`SKILL_ACTIVITY_LIMITS`): an activity row is a label, never a transport for package text. Envelopes require `family: "skill"`; there is no missing-family inference.

## Remote import and discovery

- Remote import is fixed-host (skills.sh, api.github.com, raw.githubusercontent.com) on top of the existing `url-safety.ts` guard, with per-request and whole-review deadlines, manual redirects, DNS-pinned fetches (no second lookup, no cookies) and streamed byte caps. `parseSkillUrl` rejects dot segments and encoded separators BEFORE `new URL` normalizes them away, and a slash-bearing branch is resolved through `matching-refs` (longest actual ref wins) rather than guessing where the branch name ends.
- Files are read at one resolved commit SHA, and a known package path reads only that subtree (`{commit}:{path}`), since a whole-repository tree is megabytes for collections like anthropics/skills.
- Import and update hold NO server state: the client names the reviewed repository, commit, path and locally computed content hash, and the server re-reads that immutable commit and refuses anything whose hash differs. Server memory does not reliably survive between requests, so a token store made every import fail with "review expired"; the hash is the guarantee, not the token.
- Discovery uses the undocumented public `skills.sh/api/search`, which ignores `offset`/`page`, so "show more" is a larger `limit` (20 → 100). Ids are one path segment and carry real punctuation (`react:components`, `pdf-merge-&-split`): validate addressability, not an alphabet, and skip a row that fails rather than failing the page. Link and file imports must keep working when this endpoint does not.
- ZIP reading validates central AND local headers, rejects encryption/links/overlaps, and verifies the actual CRC of decompressed bytes against the central directory. Binary/undecodable files are reported together, never silently dropped, and nothing is extracted to disk.
- The package review preview drops the mermaid plugin: a diagram can pull external references that the Markdown `img` override does not cover, so review keeps those fences as source.
