// Storage the way a browser has it, so a second tab reads what the first wrote.
import "fake-indexeddb/auto";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fakeDocumentServer,
  freshDocumentDevice,
} from "../../../../tests/fixtures/document-server.ts";
import { toMarkdown } from "../editor/markdown.ts";
import type { PushDocumentInput, PushDocumentResult } from "../schema.ts";
import { browserEditorExtensions } from "../ui/rich-editor/editor-extensions.ts";
import { DocumentSync } from "./document-sync.ts";
import { deviceCache } from "~/modules/cache/client/device-cache.ts";
import { outbox, type OutboxEntry, type OutboxStore } from "./outbox.ts";
import { caretsOf } from "./presence.ts";

let server: ReturnType<typeof fakeDocumentServer>;
const open = new Set<DocumentSync>();
beforeEach(async () => {
  await freshDocumentDevice();
  server = fakeDocumentServer();
  server.seed({
    id: "plan",
    conversationId: "conversation",
    projectId: null,
    title: "Plan",
    content: "Keep this\n\nRemove me",
    revision: 0,
    lastEditedBy: "model",
    canEdit: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
});
afterEach(() => {
  for (const sync of open) sync.destroy();
  open.clear();
});

const offline = (): Promise<PushDocumentResult> => Promise.reject(new Error("offline"));
/** An editor on the plan; pushes reach the server unless they are cut off. */
const connect = async (
  push: (data: PushDocumentInput) => Promise<PushDocumentResult>,
  store: OutboxStore = outbox,
) => {
  const sync = new DocumentSync({
    documentId: "plan",
    push,
    connect: (url) => new server.EventSource(url),
    extensions: browserEditorExtensions,
    outbox: store,
    user: { name: "Ada", color: "red", colorLight: "pink" },
  });
  open.add(sync);
  await waitFor(() => expect(sync.editor).not.toBeNull());
  return sync;
};
const online = (data: PushDocumentInput) => server.push({ data });
const markdown = (sync: DocumentSync) => toMarkdown(sync.editor!.state.doc);
/** Where `text` starts in the editor's document, as a position to type at. */
const at = (sync: DocumentSync, text: string) => {
  let found = -1;
  sync.editor!.state.doc.descendants((node, position) => {
    if (found < 0 && node.isText && node.text?.includes(text))
      found = position + node.text.indexOf(text);
  });
  return found;
};
/** Closes the tab: the connection goes, its unsent changes stay on the device. */
const reload = (sync: DocumentSync) => {
  sync.destroy();
  open.delete(sync);
};

/** A minimal lock manager, shared as tabs of one browser share it. */
const installLocks = () => {
  const held = new Map<string, Promise<void>>();
  const request = (
    name: string,
    ...args: [unknown, ((lock: unknown) => unknown)?] | [(lock: unknown) => unknown]
  ) => {
    const [options, callback] =
      args.length === 2 ? args : [{}, args[0] as (lock: unknown) => unknown];
    const ifAvailable = (options as { ifAvailable?: boolean }).ifAvailable;
    const run = async () => {
      const done = Promise.resolve(callback!({ name })).then(() => held.delete(name));
      held.set(
        name,
        done.then(() => undefined),
      );
    };
    const busy = held.get(name);
    if (!busy) return run();
    if (ifAvailable) return Promise.resolve(callback!(null));
    return busy.then(run);
  };
  const query = async () => ({ held: [...held.keys()].map((name) => ({ name })) });
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request, query } });
};

describe("document connection", () => {
  it("keeps typing the server never got across a reload, and sends it after", async () => {
    const first = await connect(offline);
    first.editor!.commands.insertContentAt(at(first, "Keep"), "Please ");
    expect(first.pending()).toBe(true);
    reload(first);

    const second = await connect(online);
    expect(markdown(second)).toBe("Please Keep this\n\nRemove me");
    await waitFor(() => expect(server.content("plan")).toBe("Please Keep this\n\nRemove me"));
    await waitFor(() => expect(second.pending()).toBe(false));
  });

  it("gives a second tab its own identity while the first still owns the unsent steps", async () => {
    installLocks();
    try {
      const first = await connect(offline);
      // Typed a key at a time, as a person does: one step per character.
      const start = at(first, "Keep");
      for (const [offset, character] of [..."Please "].entries())
        first.editor!.commands.insertContentAt(start + offset, character);
      await waitFor(() => expect(outbox.get("plan")).toBeDefined());

      // Another tab: its own copy of the cache, over the same storage.
      const otherTab = deviceCache<OutboxEntry>({
        namespace: "document-outbox",
        maxBytes: 1 << 24,
      });
      await otherTab.warm();
      const second = await connect(online, otherTab);
      // The second tab neither takes the first one's text nor its identity.
      expect(markdown(second)).toBe("Keep this\n\nRemove me");
      second.editor!.commands.insertContentAt(at(second, "Remove"), "Do ");
      await waitFor(() => expect(server.content("plan")).toBe("Keep this\n\nDo Remove me"));
      const pushed = server.pushes
        .filter((push) => push.steps?.length)
        .map((push) => push.clientId);
      expect(pushed).not.toContain(outbox.get("plan")!.clientId);
      expect(outbox.get("plan")!.steps.length).toBeGreaterThan(1);
      // The first tab closes with that text unsent: the second takes the
      // outbox over and keeps the text to copy back, rather than wiping it.
      reload(first);
      await waitFor(() => expect(second.recovered).toBe("Please"));
      expect(otherTab.get("plan")!.recovered).toBe("Please");
    } finally {
      Reflect.deleteProperty(navigator, "locks");
    }
  });

  it("keeps the words of saved steps that no longer load, instead of dropping them", async () => {
    // Saved before a schema change: its document no longer fits the schema.
    outbox.set("plan", {
      clientId: "old",
      revision: 0,
      doc: { type: "no-such-node" },
      steps: [
        JSON.stringify({
          stepType: "replace",
          from: 1,
          to: 1,
          slice: { content: [{ type: "text", text: "Saved words" }] },
        }),
      ],
      savedAt: Date.now(),
    });
    const sync = await connect(online);
    expect(sync.recovered).toBe("Saved words");
    expect(markdown(sync)).toBe("Keep this\n\nRemove me");
  });

  it("keeps the typing of a tab that did not own the outbox, once it has closed", async () => {
    installLocks();
    try {
      const owner = await connect(online);
      const other = await connect(offline);
      other.editor!.commands.insertContentAt(at(other, "Remove"), "Do not ");
      reload(other);
      await outbox.flush();
      reload(owner);
      await outbox.flush();
      // Whoever owns the document next finds what the closed tab left.
      const next = await connect(online);
      await waitFor(() => expect(next.recovered).toBe("Do not"));
    } finally {
      Reflect.deleteProperty(navigator, "locks");
    }
  });

  it("restores another tab's unsent typing though this tab's cache loaded before it", async () => {
    // This tab's cache loads first, while nothing is saved yet.
    const thisTab = deviceCache<OutboxEntry>({ namespace: "document-outbox", maxBytes: 1 << 24 });
    await thisTab.warm();
    const first = await connect(offline);
    first.editor!.commands.insertContentAt(at(first, "Keep"), "Please ");
    reload(first);
    await outbox.flush();
    // The lock is free by now: this tab owns the entry at once.
    const second = await connect(online, thisTab);
    expect(markdown(second)).toBe("Please Keep this\n\nRemove me");
  });

  it("rebases what was typed offline over what others wrote meanwhile", async () => {
    const first = await connect(offline);
    first.editor!.commands.insertContentAt(at(first, "Keep"), "Please ");
    reload(first);
    server.editElsewhere("plan", (text) => `${text}\n\nAdded elsewhere`);

    const second = await connect(online);
    await waitFor(() =>
      expect(server.content("plan")).toBe("Please Keep this\n\nRemove me\n\nAdded elsewhere"),
    );
    expect(markdown(second)).toBe(server.content("plan"));
    expect(second.recovered).toBeNull();
  });

  it("keeps another person's caret while their newest one waits for its steps", async () => {
    const sync = await connect(online);
    const caret = () => caretsOf(sync.editor!.state).find((each) => each.clientId === "bea");
    const user = { name: "Bea", color: "blue", colorLight: "lightblue" };
    const doc = sync.editor!.state.doc;
    // Everything selected: the head is past the last block, placed at the end of its text.
    server.presence("plan", "bea", { anchor: 0, head: doc.content.size, revision: 0, user });
    await waitFor(() => expect(caret()).toBeDefined());
    expect(caret()!.head).toBe(at(sync, "Remove me") + "Remove me".length);
    // Sent with a step this editor has not received yet.
    server.presence("plan", "bea", { anchor: 3, head: 3, revision: 1, user });
    expect(caret()!.head).toBe(at(sync, "Remove me") + "Remove me".length);
  });

  it("hands back text that has nowhere to go instead of dropping it", async () => {
    const first = await connect(offline);
    first.editor!.commands.insertContentAt(at(first, "me"), "certainly ");
    reload(first);
    // Someone removes the paragraph that offline typing went into.
    server.editElsewhere("plan", () => "Keep this");

    const second = await connect(online);
    await waitFor(() => expect(second.recovered).toBe("certainly"));
    expect(markdown(second)).toBe("Keep this");
    second.dismissRecovered();
    expect(second.recovered).toBeNull();
  });

  it("hands back what was typed, corrections and repeats included, after a reset", async () => {
    server.editElsewhere("plan", (text) => `${text}!`);
    const first = await connect(offline);
    // "Keep this this", typed a key at a time with a slip corrected: the net text is " this".
    const start = at(first, "Keep this") + "Keep this".length;
    for (const [offset, character] of [..." thsi"].entries())
      first.editor!.commands.insertContentAt(start + offset, character);
    first.editor!.commands.deleteRange({ from: start + 3, to: start + 5 });
    for (const [offset, character] of [..."is"].entries())
      first.editor!.commands.insertContentAt(start + 3 + offset, character);
    reload(first);
    server.seed({ ...server.row("plan")!, content: "Fresh start" });
    const second = await connect(online);
    await waitFor(() => expect(markdown(second)).toBe("Fresh start"));
    expect(second.recovered).toBe("this");
  });

  it("hands back unsent text when the server can no longer rebase it", async () => {
    server.editElsewhere("plan", (text) => `${text}!`);
    const first = await connect(offline);
    first.editor!.commands.insertContentAt(at(first, "Keep"), "Please ");
    reload(first);
    // The document was rebuilt since: the saved revision is ahead of anything the server holds.
    server.seed({ ...server.row("plan")!, content: "Fresh start" });

    const second = await connect(online);
    await waitFor(() => expect(markdown(second)).toBe("Fresh start"));
    expect(second.recovered).toBe("Please");
    // Closing the panel does not take it along; dismissing does.
    reload(second);
    const third = await connect(online);
    expect(third.recovered).toBe("Please");
    third.dismissRecovered();
    reload(third);
    const fourth = await connect(online);
    expect(fourth.recovered).toBeNull();
  });

  it("reports changes stored only once the server has them", async () => {
    const release = server.holdPushes();
    const sync = await connect(online);
    sync.editor!.commands.insertContentAt(at(sync, "Keep"), "Please ");
    const flushed = sync.flush();
    expect(sync.pending()).toBe(true);
    release();
    await expect(flushed).resolves.toBe(true);
    expect(server.content("plan")).toBe("Please Keep this\n\nRemove me");
  });
});
