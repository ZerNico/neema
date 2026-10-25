# Projects

A project is a place for continuing work: instructions every chat in it follows, documents,
files and memory shared by its members, and the people who may use it. It does not configure
the chat: model, agent, collections, skills and search stay ordinary composer choices.

## Roles and access

- Roles are owner, editor and viewer. The owner is `projects.user_id`, never a member row;
  editors and viewers come from `project_members` or `project_group_grants`, and a person's
  roles add up, the highest winning. `projectRoleSql` in `projects/server/access.ts` is the
  one place that decides it, embedded in every read that needs it.
- A reader needs the Use grant and the owner still needs Create
  ([feature access](feature-policy.md)): losing Create, or a ban, suspends the project for everyone,
  the owner included, without deleting it.
- Only the owner manages members. Granting to a group needs that group's `share_projects`
  right on the owner's own membership, taken `FOR SHARE` through the insert like the other
  kinds; an admin owner may grant to any group. Membership alone never allows it.
- Anyone may leave their direct membership; one through a group is the group's.

## Chats in a project

- A chat stays its owner's alone. `conversations.project_id` links it to a project's
  context; nobody else ever sees it, and the project page lists only the reader's own chats.
  A chat moves in or out from its menu; a temporary chat never joins.
- Every attempt (send, retry, edit, structured answer, queue promotion) resolves the project
  inside its transaction, like an agent, and snapshots `resolvedProject` beside the answer.
  Lost access fails the turn with a message saying so; it never quietly drops the project's
  instructions. A steer joins the running answer with the project as that answer read it, so
  nothing it brings can outrun the role: every project write checks it again in its own
  transaction.
- Project instructions are a system-role `<project-instructions>` block after application
  policy and memory, and before an agent's instructions, which refine them. Editors are
  other people, so the block steers answers but grants nothing; see `system-prompt.ts`.
- A branch keeps the project while its owner may still use it, and leaves it otherwise.
- Deleting a project deletes its documents, files and memory; its chats become ordinary
  chats and keep their messages. Deletion locks the owner's account, then attached chats in ID
  order, then the project and its blobs. The project lock blocks new foreign-key attachments.
  Chats attached while deletion waited are locked without waiting or the transaction retries,
  so it never waits for a chat while holding the project.

## Documents and memory

- A document belongs to exactly one chat or one project (`documents_one_owner`). A project's
  document outlives any answer and is deleted explicitly by an editor; a chat's still goes
  with its answer. Editors write, viewers follow along read-only, cursor included. See
  [documents](documents.md).
- In a project chat the model's manifest lists both kinds with a `scope`. A new document
  goes into the project by default when the person may edit it: someone working in a
  project means the shared copy, and nothing moves a document between the two later.
  `scope: "chat"` keeps private scratch in the chat; a viewer's documents always stay in
  the chat, and their model sees project documents as read-only. Plain chats keep the
  manifest they had. The card and the panel say "Project" so the two never look alike.
- Project memory holds facts about the work (decisions, conventions, status), never facts
  about a person. It follows the project role, not the personal memory feature: it belongs
  to the project like its documents. See [memory](memory.md).
- Change hints fan out to every member, resolved at publish time; each refetch is
  authorized on its own.

## Files

- A project file is a working file people replace rather than co-edit: a deck, a
  spreadsheet, a PDF, anything. Each save is a whole new immutable version in
  `project_file_versions`; the current version is the highest number. Any type is kept and
  classified by its bytes like every other file ([files](files.md)).
- A save names the version it started from and is refused when the file moved on, so
  nobody's version lands unseen on top of a newer one. Every accepted save or restore advances
  that number, even repeated saves by one person or one answer. A kept version ID always
  addresses the same bytes.
- Retention: older unpinned versions go after 30 days or past 25 per file; up to 10 pins
  per file are kept until unpinned. The current version of every file is never pruned. A
  project has no size of its own: its bytes count to the owner's
  [storage quota](limits.md#storage), which decides what a person may add. The model's saves
  are counted there but never refused, like every file an answer makes, so file count, file
  size and retention are what bound them. Writes, pins, removals and retention take the same
  exclusive project lock before counting files or changing versions, after any generation's conversation
  lock and before blob locks. A write takes account key-share locks for the owner and author
  before those locks, since registering blobs and versions would otherwise take them later.
  Each write prunes in its own transaction. An hourly sweep
  catches projects nobody wrote to. Edit authority and the generation fence are checked before
  storing bytes, then checked again in the registering transaction. Blob I/O holds no transaction.
- Bytes are `attachment_blobs` registered under the project owner, deduplicated with the
  owner's own files. A version is one more owner in the orphan check, so dropping a
  version, a file or the project records cleanup intents in the same transaction and the
  [blob ledger](../../AGENTS.md#invariants) settles them.
- The model gets `list_project_files`, `read_project_file` and, for an editor,
  `save_project_file`, only in a project chat. A read hands it the file's text when there
  is a reader for it, for the rest of that answer; the tool row keeps only which file and
  version. A save takes either text content or a chat file by id or name, and runs under
  the answer's generation fence, taken before the project row.
- A custom or presentation tool reads a project file through an authorized, pinned
  reference. Its result names the version it read; it can edit a private working copy,
  but only a published attachment can be passed to `save_project_file` as the next
  version under the same conflict check a person's save gets. Nothing saves a tool's
  output to the project on its own: the version check depends on naming the version
  it started from. Opening and publishing a draft ask only whether the sender may still
  read the version it came from (a role in the project, and that version still kept), so
  a newer version does not block publication while losing membership does. The read-only
  slide preview reauthorizes immutable project versions on each request; it does not
  change version retention.
