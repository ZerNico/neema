# Projects

A project is a place for continuing work: instructions every chat in it follows, documents
and memory shared by its members, and the people who may use it. It does not configure
the chat: model, agent, collections, skills and search stay ordinary composer choices.

## Roles and access

- Roles are owner, editor and viewer. The owner is `projects.user_id`, never a member row;
  editors and viewers come from `project_members` or `project_group_grants`, and a person's
  roles add up, the highest winning. `projectRoleSql` in `projects/server/access.ts` is the
  one place that decides it, embedded in every read that needs it.
- A reader needs the Use grant and the owner still needs Create
  ([feature access](feature-policy.md)): losing Create suspends the project for everyone,
  the owner included, without deleting it.
- Only the owner manages members. Granting to a group needs that group's `share_projects`
  right on the owner's own membership, taken `FOR SHARE` through the insert like the other
  kinds; an admin owner may grant to any group. Membership alone never allows it.
- Anyone may leave their direct membership; one through a group is the group's.

## Chats in a project

- A chat stays its owner's alone. `conversations.project_id` links it to a project's
  context; nobody else ever sees it, and the project page lists only the reader's own chats.
  A chat moves in or out from its menu; a temporary chat never joins.
- Every attempt (send, retry, edit, structured answer, queue promotion, steer) resolves the
  project inside its transaction, like an agent, and snapshots `resolvedProject` beside the
  answer. Lost access fails the turn with a message saying so; it never quietly drops the
  project's instructions.
- Project instructions enter the prompt as a user-role `<project-instructions>` block after
  application policy and before an agent's instructions, which refine them.
- A branch keeps the project while its owner may still use it, and leaves it otherwise.
- Deleting a project deletes its documents and memory; its chats become ordinary chats and
  keep their messages.

## Documents and memory

- A document belongs to exactly one chat or one project (`documents_one_owner`). A project's
  document outlives any answer and is deleted explicitly by an editor; a chat's still goes
  with its answer. Editors write, viewers follow along read-only, cursor included. See
  [documents](documents.md).
- In a project chat the model's manifest lists both kinds with a `scope`, and
  `create_document` takes `scope: "project"`. A viewer's model sees project documents as
  read-only. Plain chats keep the manifest they had.
- Project memory holds facts about the work (decisions, conventions, status), never facts
  about a person. It follows the project role, not the personal memory feature: it belongs
  to the project like its documents. See [memory](memory.md).
- Change hints fan out to every member, resolved at publish time; each refetch is
  authorized on its own.
