import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serialWrites, writeJsonAtomic } from "./json-file.ts";
import type { AnswerKey, ChatKey, GrantTarget } from "./egress-grants.ts";

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
  keepAnswers(origin: string, live: readonly AnswerKey[]): void;
  forgetChat(chat: ChatKey): Promise<void>;
}

const chatKey = ({ origin, conversationId }: ChatKey) => `${origin} ${conversationId}`;
const answerKey = (answer: AnswerKey) => `${chatKey(answer)} ${answer.attempt}`;

interface Stored {
  always: string[];
  chats: Record<string, string[]>;
}

/** `valid` holds a hand-edited file to the same rules as a fresh request. */
export const loadScopedGrants = async (
  directory: string,
  fileName: string,
  valid: (entry: string) => boolean,
): Promise<ScopedGrants> => {
  const file = join(directory, fileName);
  const entries = (value: unknown) =>
    Array.isArray(value)
      ? [
          ...new Set(
            value.filter((item): item is string => typeof item === "string" && valid(item)),
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
  const answers = new Map<string, string[]>();
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
      const next = edit(answers.get(key) ?? []);
      if (next.length > 0) answers.set(key, next);
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

  return {
    applying: (answer) => [
      ...new Set([
        ...stored.always,
        ...(stored.chats[chatKey(answer)] ?? []),
        ...(answers.get(answerKey(answer)) ?? []),
      ]),
    ],
    list: (target) =>
      target.scope === "always"
        ? [...stored.always]
        : target.scope === "chat"
          ? [...(stored.chats[chatKey(target.chat)] ?? [])]
          : [...(answers.get(answerKey(target.answer)) ?? [])],
    add: (target, entry) => change(target, entry, true),
    remove: (target, entry) => change(target, entry, false),
    keepAnswers: (origin, live) => {
      const kept = new Set(live.map(answerKey));
      for (const key of answers.keys())
        if (key.startsWith(`${origin} `) && !kept.has(key)) answers.delete(key);
    },
    forgetChat: async (chat) => {
      for (const key of answers.keys())
        if (key.startsWith(`${chatKey(chat)} `)) answers.delete(key);
      await persist((current) => {
        const chats = { ...current.chats };
        delete chats[chatKey(chat)];
        return { ...current, chats };
      });
    },
  };
};
