import { readFile } from "node:fs/promises";
import { serialWrites, writeJsonAtomic } from "../json-file.ts";

/** Chats keep their own answers only for the most recent this many, as browser sites do. */
const KEPT_CHATS = 500;

interface Saved {
  readonly always: ReadonlyArray<string>;
  readonly chats: Readonly<Record<string, ReadonlyArray<string>>>;
}

/**
 * Which apps a server's chats may use on this machine, by bundle id: in one chat, or in every
 * chat. Kept on the machine, like folder and site grants, so the server never learns which apps
 * a person trusts (docs/internals/app-use.md).
 */
export class AppGrants {
  private always = new Set<string>();
  /** In insertion order, oldest first, so the oldest chats are the ones dropped. */
  private chats = new Map<string, Set<string>>();
  private readonly write = serialWrites();
  private loaded: Promise<void> | null = null;

  constructor(private readonly file: string) {}

  private load() {
    this.loaded ??= readFile(this.file, "utf8")
      .then((text) => {
        const saved = JSON.parse(text) as Partial<Saved>;
        this.always = new Set(Array.isArray(saved.always) ? saved.always : []);
        for (const [chat, apps] of Object.entries(saved.chats ?? {}))
          if (Array.isArray(apps)) this.chats.set(chat, new Set(apps));
      })
      .catch(() => {});
    return this.loaded;
  }

  private save() {
    const chats = Object.fromEntries([...this.chats].map(([chat, apps]) => [chat, [...apps]]));
    const saved: Saved = { always: [...this.always], chats };
    return this.write(() => writeJsonAtomic(this.file, saved));
  }

  async allowed(conversationId: string, appId: string) {
    await this.load();
    return this.always.has(appId) || (this.chats.get(conversationId)?.has(appId) ?? false);
  }

  /** Whether the app may be used from another device: only what the person always allows. */
  async alwaysAllowed(appId: string) {
    await this.load();
    return this.always.has(appId);
  }

  async allow(conversationId: string, appId: string, scope: "chat" | "always") {
    await this.load();
    if (scope === "always") this.always.add(appId);
    else {
      const apps = this.chats.get(conversationId) ?? new Set<string>();
      apps.add(appId);
      // Re-inserted, so this chat counts as the most recent.
      this.chats.delete(conversationId);
      this.chats.set(conversationId, apps);
      for (const chat of this.chats.keys()) {
        if (this.chats.size <= KEPT_CHATS) break;
        this.chats.delete(chat);
      }
    }
    await this.save();
  }

  /** A chat's answers go with the chat. */
  async forgetChat(conversationId: string) {
    await this.load();
    if (this.chats.delete(conversationId)) await this.save();
  }

  async alwaysList() {
    await this.load();
    return [...this.always];
  }

  async disallow(appId: string) {
    await this.load();
    if (this.always.delete(appId)) await this.save();
  }
}
