# Portable skills

A skill is a SKILL.md package (`src/modules/skills`), not a permission and not a tool. Nothing in a package ever executes.

## Built-in skills

- The two authoring skills (`builtin:agent-authoring`, `builtin:schedule-authoring`) are
  hardcoded constants in `src/modules/skills/bundled/`, single-file, with no DB rows, blobs,
  or revisions. They exist so the model loads authoring depth on demand instead of carrying
  an always-on policy in the prompt prefix; the fixed prefix keeps a one-line pointer.
- `SkillRepo.catalogue` prepends them as ambient entries with `revisionId: "builtin"`;
  `SkillReader.readPinned` returns the bundled root for a builtin id and never touches the
  database or blob store. Nothing pins them in `message_skills`: builtin content is versioned
  with the app, and a replayed old message reads today's text, which is acceptable because
  instructions are app behaviour, not user data.
- They need no guards against editing, deletion, or id collision because they exist in no
  table. The composer skill picker reads `SkillService.list`, which is DB-only, so a
  `builtin:` id can never be pinned into a generation config that a retry would then fail to
  resolve.

## Storage and lifecycle

- The raw document is the ONLY metadata source: name/description are parsed from its frontmatter, so there is no competing metadata form state. The editor's simple form is a view of that document: `readSkillDocument`/`writeSkillDocument` edit SKILL.md in place and keep every other key, and a document they can't read opens in advanced mode instead. Unsupported directives (hooks, `context: fork`, shell substitutions) are flagged once on SKILL.md; script files are kept as ordinary text without a per-file warning, since nothing in a skill is ever executed.
- Revisions are immutable; files live in the existing BlobStore/`attachment_blobs` registry with candidate/orphan cleanup intents, deduplicated per user by SHA. `collectUnused` runs two passes (superseded local revisions, then their newly unreferenced baselines) and retains anything a `message_skills` row or another revision's baseline pointer references.
- A file is skill text when it decodes as UTF-8 without control characters and fits the 256 KiB text limit; anything else (a template, image, font, or large data) is a binary asset up to the 20 MiB any stored file may be, in a package of up to 50 MiB. `SKILL.md` is always text. `skill_files.media_type` is null for text and names a binary's type: the shared blob row keeps whichever type its first writer gave it, so the skill records its own.
- Binary bytes never travel as JSON. The editor uploads through `uploadSkillAsset` (skill authoring, not the attachments feature), which stores an ordinary unclaimed upload; the save takes its blob over and deletes the spent upload row. A later save keeps a binary by its hash, which must name a file of the current revision or its baseline, and the save rechecks under lock that those bytes are still stored. ZIP imports upload their binaries first; GitHub imports store them server-side and send the browser only a description. Downloads and export address a binary by hash, so a draft that renamed it still finds it.
- The account quota is 200 skills and 250 MiB of stored files, each blob counted once however many revisions share it; counting per revision made a large template exhaust it after a few text edits.
- Soft deletion blocks new attempts while history stays readable and blobs stay put; reclamation currently triggers only on a skill save or removal, not on history deletion.
- An imported upstream baseline is stored as a **negative** `skill_revisions.revision` ordinal on the same skill, sharing the immutable file lifecycle but never exposed through any public API. An update applies the fetched upstream as the new baseline even when the owner keeps local choices, so the next three-way comparison (`update.ts`, whole-file only, no text merge) stays honest.
- `SkillReader` is a private execution-only service; owner detail/export/baseline reads live in `SkillService`. Recipients get safe metadata plus invocation, never bodies or the editor API, because instructions can't be kept secret from someone who can use the skill (the editor says so).

## Access and authorization

- A reader needs skills Use, the author still needs skills Create, and the ordinary
  resource ACL must allow the read. Revoking Create suspends that author's skills for
  everyone without deleting revisions; Create also gates import, update and removal.
  Built-in authoring entries follow their target feature grant. See
  [feature access](feature-policy.md).
- Every new attempt (send, retry, edit, structured answer, branch) resolves current revisions and ACLs inside the attempt transaction, before any destructive reset. Original standalone IDs stay separate from agent dependencies, including overlaps, so removing a skill from an agent leaves an explicit selection intact.
- Active attempts pin content but recheck access: losing it is sticky and terminal, never a recoverable failed tool result.
- `SkillRepo.catalogue` adds every readable, non-manual-only skill as an `ambient` manifest entry at dispatch (host turn and investigation alike), on top of the attempt's pinned selections. Ambient entries are metadata-only offers, not authorized as attempt dependencies, so losing access to one never fails a turn, while `readPinned` still checks access per read. The prompt says the descriptions are all the model has and to call `load_skill` when one matches; without that instruction a listed skill simply never gets used.
- An agent's own skills sit between the two tiers: offered on demand like an ambient entry, authorized like a pinned one, marked `forThisAgent` in the catalogue with a prompt line telling the model to prefer them. Without that marking an agent's skills are indistinguishable from everything else the reader owns, which made attaching one a near no-op that only converted "silently not offered" into a hard turn failure.
- Attaching a skill to an agent is a preference, never a pin: it changes what is offered, not what is authorized ahead of time.
- Manual-only means "never offered on its own", not "unusable". The ambient query excludes those at the source, so a deliberate selection or an agent attachment is the only way to reach one; filtering the catalogue on `explicit` alone left an agent's manual-only skill authorized, able to fail the turn, and silently absent from the list. The catalogue filter keys off `ambient`.

## Runtime bounds

- `read_skill_file` never returns a binary's bytes: it answers with an exact `skill:<revision>/<path>` [file reference](files.md#files-into-tools) a tool can open. The resolver accepts one only for a skill this attempt was offered, at the revision it pinned; a draft opened from one stays usable while the skill is readable. A recipient's answer can therefore publish a deck built from a shared master, the same limit as instructions that can't be kept secret. Fonts in a loaded skill also draw in that answer's [presentation previews](presentations.md#fonts), checked like an admin upload.
- `load_skill`/`read_skill_file` are bounded (20 catalogue entries, 5 loaded, 32 shared operations, 2 concurrent reads, exact UTF-16 continuations). Every pinned root, and a root loaded in this attempt, is its own message in protected trailing context, never duplicated into tool output: pinned ones in the part fixed for the answer, a mid-answer load after the rounds (see [prompt caching](prompt-caching.md)). The remaining-operations count rides the per-round reminder. Required instructions that don't fit are refused, never truncated.
- A load outlives its attempt without living in the trailing context. On later turns the first retained `load_skill` row for a skill replays that root as a user-role message just before the answer that loaded it, and the session reports the skill as already loaded. The trailing context is rebuilt on every request and sits after a growing history, so a root kept there is never cached; one replayed from stored rows is byte-identical each turn and caches with the history. Without either, the catalogue told the model the skill was unloaded and every turn paid a reload round trip.
- The replay belongs to its answer's history group, so compaction and overflow repair drop the two together, after which the skill is offered again; a rewind deletes the row and so the replay. It reads the current attempt's pinned revision and only for skills that attempt could load itself: removed or unshared skills vanish, an edited one changes its replay once, and a pinned skill is already in protected context.
- Research workers share one session, budget and semaphore for `load_skill`/`read_skill_file` across all tasks in a run.
- `projectSkillToolResult` is the only path to durable rows and SSE, and every displayed field is length-bounded (`SKILL_ACTIVITY_LIMITS`): an activity row is a label, never a transport for package text. Envelopes require `family: "skill"`; there is no missing-family inference.

## Remote import and discovery

- Remote import is fixed-host (skills.sh, api.github.com, raw.githubusercontent.com) on top of the existing `url-safety.ts` guard, with per-request and whole-review deadlines, manual redirects, DNS-pinned fetches (no second lookup, no cookies) and streamed byte caps. `parseSkillUrl` rejects dot segments and encoded separators BEFORE `new URL` normalizes them away, and a slash-bearing branch is resolved through `matching-refs` (longest actual ref wins) rather than guessing where the branch name ends.
- Files are read at one resolved commit SHA, and a known package path reads only that subtree (`{commit}:{path}`), since a whole-repository tree is megabytes for collections like anthropics/skills.
- Import and update hold NO server state: the client names the reviewed repository, commit, path and locally computed content hash, and the server re-reads that immutable commit and refuses anything whose hash differs. Server memory does not reliably survive between requests, so a token store made every import fail with "review expired"; the hash is the guarantee, not the token.
- Discovery uses the undocumented public `skills.sh/api/search`, which ignores `offset`/`page`, so "show more" is a larger `limit` (20 → 100). Ids are one path segment and carry real punctuation (`react:components`, `pdf-merge-&-split`): validate addressability, not an alphabet, and skip a row that fails rather than failing the page. Link and file imports must keep working when this endpoint does not.
- ZIP reading validates central AND local headers, rejects encryption/links/overlaps, and verifies the actual CRC of decompressed bytes against the central directory. Binary files are kept as assets, and nothing is extracted to disk.
- The package review preview drops the mermaid plugin: a diagram can pull external references that the Markdown `img` override does not cover, so review keeps those fences as source.
