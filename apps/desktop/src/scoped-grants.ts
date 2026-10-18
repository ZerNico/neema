import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serialWrites, writeJsonAtomic } from "./json-file.ts";

export interface ChatKey {
  readonly origin: string;
  readonly conversationId: string;
}

export interface AnswerKey extends ChatKey {
  readonly attempt: string;
}

export type GrantTarget =
  | { readonly scope: "always" }
  | { readonly scope: "chat"; readonly chat: ChatKey }
  | { readonly scope: "answer"; readonly answer: AnswerKey };

/** One entry a scope change took away, so the caller can close what it allowed. */
export interface DroppedGrant {
  readonly target: GrantTarget;
  readonly entry: string;
}

/**
 * Grants of one kind in the three scopes a person picks from: the answer that
 * asked (memory only), the chat and every chat (in the profile). Entries are
 * strings; the caller decides what they mean and which are valid.
 */
export interface ScopedGrants {
  /** Every entry that applies to this answer, from all three scopes. */
  applying(answer: AnswerKey): readonly string[];
  list(target: GrantTarget): readonly string[];
  add(target: GrantTarget, entry: string): Promise<void>;
  remove(target: GrantTarget, entry: string): Promise<void>;
  /** Ends every answer of this server that is not listed as still running. */
  keepAnswers(origin: string, live: readonly AnswerKey[]): readonly DroppedGrant[];
  /** Drops a deleted chat's grants, its answers' included. */
  forgetChat(chat: ChatKey): Promise<readonly DroppedGrant[]>;
}

export const chatKey = ({ origin, conversationId }: ChatKey) => `${origin} ${conversationId}`;
export const answerKey = (answer: AnswerKey) => `${chatKey(answer)} ${answer.attempt}`;

interface Stored {
  always: string[];
  chats: Record<string, string[]>;
}

/**
 * `valid` holds a hand-edited file to the same rules as a fresh request. `upgrade`
 * rewrites an entry an earlier version stored in another shape, or drops it.
 */
export const loadScopedGrants = async (
  directory: string,
  fileName: string,
  valid: (entry: string) => boolean,
  upgrade?: (item: unknown) => string | null,
): Promise<ScopedGrants> => {
  const file = join(directory, fileName);
  const entries = (value: unknown) =>
    Array.isArray(value)
      ? [
          ...new Set(
            value
              .map((item: unknown) => (typeof item === "string" ? item : (upgrade?.(item) ?? null)))
              .filter((item): item is string => item !== null && valid(item)),
          ),
        ]
      : [];
  let stored: Stored = { always: [], chats: {} };
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object") {
      const { always, chats } = parsed as Record<string, unknown>;
      stored.always = entries(always);
      if (chats && typeof chats === "object")
        for (const [key, value] of Object.entries(chats)) {
          const kept = entries(value);
          if (kept.length > 0) stored.chats[key] = kept;
        }
    }
  } catch {
    // A lost or invalid file grants nothing.
  }
  // Keyed by answerKey; the answer itself is kept so nothing has to split the key apart.
  const answers = new Map<string, { answer: AnswerKey; entries: string[] }>();
  const queue = serialWrites();
  // The next state is built inside the queue, so overlapping changes never drop each other.
  const persist = (update: (current: Stored) => Stored) =>
    queue(async () => {
      const next = update(stored);
      await writeJsonAtomic(file, next);
      stored = next;
    });

  const change = async (target: GrantTarget, entry: string, add: boolean) => {
    const edit = (current: readonly string[]) => {
      const without = current.filter((item) => item !== entry);
      return add ? [...without, entry] : without;
    };
    if (target.scope === "answer") {
      const key = answerKey(target.answer);
      const next = edit(answers.get(key)?.entries ?? []);
      if (next.length > 0) answers.set(key, { answer: target.answer, entries: next });
      else answers.delete(key);
    } else if (target.scope === "always") {
      await persist((current) => ({ ...current, always: edit(current.always) }));
    } else {
      const key = chatKey(target.chat);
      await persist((current) => {
        const chats = { ...current.chats };
        const next = edit(chats[key] ?? []);
        if (next.length > 0) chats[key] = next;
        else delete chats[key];
        return { ...current, chats };
      });
    }
  };

  const dropAnswers = (ends: (answer: AnswerKey) => boolean) => {
    const dropped: DroppedGrant[] = [];
    for (const [key, { answer, entries: granted }] of answers) {
      if (!ends(answer)) continue;
      for (const entry of granted) dropped.push({ target: { scope: "answer", answer }, entry });
      answers.delete(key);
    }
    return dropped;
  };

  return {
    applying: (answer) => [
      ...new Set([
        ...stored.always,
        ...(stored.chats[chatKey(answer)] ?? []),
        ...(answers.get(answerKey(answer))?.entries ?? []),
      ]),
    ],
    list: (target) =>
      target.scope === "always"
        ? [...stored.always]
        : target.scope === "chat"
          ? [...(stored.chats[chatKey(target.chat)] ?? [])]
          : [...(answers.get(answerKey(target.answer))?.entries ?? [])],
    add: (target, entry) => change(target, entry, true),
    remove: (target, entry) => change(target, entry, false),
    keepAnswers: (origin, live) => {
      const kept = new Set(live.map(answerKey));
      return dropAnswers((answer) => answer.origin === origin && !kept.has(answerKey(answer)));
    },
    forgetChat: async (chat) => {
      const key = chatKey(chat);
      const dropped = dropAnswers((answer) => chatKey(answer) === key);
      await persist((current) => {
        for (const entry of current.chats[key] ?? [])
          dropped.push({ target: { scope: "chat", chat }, entry });
        const chats = { ...current.chats };
        delete chats[key];
        return { ...current, chats };
      });
      return dropped;
    },
  };
};
