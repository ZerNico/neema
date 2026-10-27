import { readFile, writeFile } from "node:fs/promises";

/**
 * Which of each chat's sent files this machine has placed in its workspace, kept per server.
 * A file is placed once: after that the workspace is the model's, so one it deleted or moved
 * stays gone. A file found already at its path counts as placed and is never overwritten.
 */
export class SentFiles {
  private loaded: Promise<Map<string, Set<string>>> | undefined;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  private all() {
    return (this.loaded ??= readFile(this.file, "utf8")
      .then((text) => JSON.parse(text) as unknown)
      .then((saved) => {
        const chats = new Map<string, Set<string>>();
        if (saved && typeof saved === "object")
          for (const [chat, ids] of Object.entries(saved))
            if (Array.isArray(ids))
              chats.set(chat, new Set(ids.filter((id): id is string => typeof id === "string")));
        return chats;
      })
      .catch(() => new Map<string, Set<string>>()));
  }

  private async save() {
    const chats = await this.all();
    const snapshot = JSON.stringify(Object.fromEntries([...chats].map(([k, v]) => [k, [...v]])));
    // Chats write concurrently; one file, written in order.
    this.writing = this.writing.then(() => writeFile(this.file, snapshot)).catch(() => {});
    await this.writing;
  }

  async placed(conversationId: string): Promise<ReadonlySet<string>> {
    return (await this.all()).get(conversationId) ?? new Set();
  }

  async record(conversationId: string, ids: readonly string[]) {
    if (ids.length === 0) return;
    const chats = await this.all();
    const chat = chats.get(conversationId) ?? new Set<string>();
    for (const id of ids) chat.add(id);
    chats.set(conversationId, chat);
    await this.save();
  }

  async forget(conversationId: string) {
    if ((await this.all()).delete(conversationId)) await this.save();
  }
}
