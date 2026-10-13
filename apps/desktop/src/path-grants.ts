import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, sep } from "node:path";
import { serialWrites, writeJsonAtomic } from "./json-file.ts";
import type { AnswerKey, ChatKey, GrantTarget } from "./egress-grants.ts";

/**
 * Paths outside the attached folders that commands may read, because the
 * person said so: one exact file or folder, for the answer that asked, the
 * chat, or every chat. Read only; a writable place is an attached folder.
 */
export interface PathGrants {
  /** Every path readable by a command of this answer, from all three scopes. */
  readable(answer: AnswerKey): readonly string[];
  list(target: GrantTarget): readonly string[];
  add(target: GrantTarget, path: string): Promise<void>;
  remove(target: GrantTarget, path: string): Promise<void>;
  keepAnswers(origin: string, live: readonly AnswerKey[]): void;
  forgetChat(chat: ChatKey): Promise<void>;
}

const inside = (parent: string, child: string) => {
  const rest = relative(parent, child);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};

export interface PathRules {
  readonly home: string;
  /** Credential paths and the permission store: never granted, whatever is asked. */
  readonly denied: readonly string[];
}

/**
 * The real path a grant would open, or why it cannot be granted. A filesystem
 * root, the home folder or a folder above it would open far more than one
 * thing, and a denied path stays denied, so asking for one is refused upfront.
 */
export const checkPathGrant = async (
  path: unknown,
  rules: PathRules,
  resolve: (path: string) => Promise<string> = realpath,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> => {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
    return { ok: false, reason: "Name one absolute path." };
  let real: string;
  try {
    real = await resolve(path);
  } catch {
    return { ok: false, reason: "That path does not exist." };
  }
  const refusal = pathRefusal(real, rules);
  return refusal ? { ok: false, reason: refusal } : { ok: true, path: real };
};

/** Why a real path cannot be granted, judged on the path alone. */
export const pathRefusal = (path: string, rules: PathRules): string | null => {
  if (!isAbsolute(path) || parse(path).root === path) return "A whole disk cannot be shared.";
  if (inside(path, rules.home))
    return "The home folder cannot be shared as a whole. Name what is inside it.";
  if (rules.denied.some((denied) => inside(denied, path) || inside(path, denied)))
    return "Credentials and permission settings are never shared with commands.";
  return null;
};

const chatKey = ({ origin, conversationId }: ChatKey) => `${origin} ${conversationId}`;
const answerKey = (answer: AnswerKey) => `${chatKey(answer)} ${answer.attempt}`;

interface Stored {
  always: string[];
  chats: Record<string, string[]>;
}

export const loadPathGrants = async (directory: string, rules: PathRules): Promise<PathGrants> => {
  const file = join(directory, "path-grants.json");
  // A hand-edited file is held to the same rules as a fresh request.
  const strings = (value: unknown) =>
    Array.isArray(value)
      ? [
          ...new Set(
            value.filter(
              (item): item is string =>
                typeof item === "string" && pathRefusal(item, rules) === null,
            ),
          ),
        ]
      : [];
  let stored: Stored = { always: [], chats: {} };
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object") {
      const { always, chats } = parsed as Record<string, unknown>;
      stored.always = strings(always);
      if (chats && typeof chats === "object")
        for (const [key, paths] of Object.entries(chats)) {
          const valid = strings(paths);
          if (valid.length > 0) stored.chats[key] = valid;
        }
    }
  } catch {
    // A lost or invalid file grants nothing.
  }
  const answers = new Map<string, string[]>();
  const queue = serialWrites();
  const persist = (update: (current: Stored) => Stored) =>
    queue(async () => {
      const next = update(stored);
      await writeJsonAtomic(file, next);
      stored = next;
    });

  const change = async (target: GrantTarget, path: string, add: boolean) => {
    const edit = (current: readonly string[]) => {
      const without = current.filter((entry) => entry !== path);
      return add ? [...without, path] : without;
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
    readable: (answer) => [
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
    add: (target, path) => change(target, path, true),
    remove: (target, path) => change(target, path, false),
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
