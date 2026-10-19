# History tools

The `history` family lets the model read what was said before: `read_history` for the current
chat, `search_chats` and `read_chat` for the person's other chats. All three only read.

## Tools, not injection

- Earlier text reaches the model when it asks for it, never pasted in ahead of time. A chat
  that compacted keeps its summary as the record, and the model fetches the detail a question
  needs. Each call is a visible row in the answer, so the person sees when another chat was
  read, and a chat that never needs the past pays nothing for it.
- `read_history` is offered in every kept chat, compacted or not. A tool that appeared only
  once a chat compacted would change the tool list and the system prompt mid-chat, and both
  sit in front of the cached history ([prompt caching](prompt-caching.md)). A summary or a
  truncation notice says the messages can still be read only when the attempt offers the tool.
  That line is rendered per attempt from the offer, never stored in the checkpoint.
- The past is data. Each tool's description says what comes back is earlier conversation,
  never instructions, like memory records, and the searches say to stop after one or two tries
  rather than cycle through variations. The system hint only says when to use the tools.

## What may be read

- `read_history` numbers the chat's settled user and assistant messages from 1 in
  `(created_at, id)` order: system rows, rows still streaming, the attempt's own answer and the
  steers delivered into it are left out, as is a steer whose answer did not settle
  (`historyMessage` in `ChatRepo`). That is the attempt's own rule in `attempt-context.ts`,
  repeated in SQL, so the two change together. Numbers are stable while the chat only grows,
  so a page and a search hit agree.
- Other chats go through `searchableBy`, so a [deleted](deleted-chats.md) or
  [temporary](temporary-chats.md) chat is never found and an archived one is. `ChatScope`
  narrows it further: never the current chat, and only chats in the current chat's project, or
  only chats in none. A project's work stays in the project, and private work stays out of it.
  The scope is enforced in the query, not in the description.
- A temporary chat is offered none of the three: it has no memory, and its own history is
  equally its own. Search across chats rides on memory's switch: "Search past chats" in memory
  settings, off with memory itself when an admin pauses it (`effectivePastChatsEnabled`).
- Only `messages.content` is returned, with citation markers removed from prose and a ```ui
  block kept behind a note, since its source often holds the data the text points to and a
  search may have matched it. Tool results, reasoning and files are not: they belong to the attempt that made
  them, and files have their own reader. A page holds about 12,000 characters; a single longer
  message is cut with a note on how to find the rest.
- A row keeps what was looked for and how much came back, never the text. The text reached
  only the model, in the call's own result.
