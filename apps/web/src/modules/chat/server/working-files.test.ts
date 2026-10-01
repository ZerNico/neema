import { afterEach, describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "~/modules/attachments/constants.ts";
import { sha256Hex } from "~/modules/attachments/server/sha256.ts";
import { createWorkingFiles, type KeptWorkingFile } from "./working-files.ts";

const active: Array<ReturnType<typeof createWorkingFiles>> = [];
const workspace = (input?: Parameters<typeof createWorkingFiles>[0]) => {
  const files = createWorkingFiles(input);
  active.push(files);
  return files;
};
afterEach(() => {
  for (const files of active.splice(0)) files.dispose();
});

const text = (value: string) => new TextEncoder().encode(value);
const owner = "custom:tool-a" as const;
const note = (value: string) => ({
  name: "note.txt",
  mediaType: "text/plain",
  bytes: text(value),
  owner,
});
const kept = (id: string, bytes: Uint8Array): KeptWorkingFile => ({
  ref: { kind: "working", id, revision: 4 },
  name: "deck.pptx",
  mediaType: "application/octet-stream",
  fingerprint: sha256Hex(bytes),
  owner: "presentation",
  attachmentId: `attachment-${id}`,
});

describe("generation working files", () => {
  it("keeps revisions and rejects stale refs, other attempts and other editors", () => {
    const first = workspace();
    const second = workspace();
    const created = first.create(note("draft"));
    expect(() => second.read(created.ref)).toThrow("not available");
    const edited = first.replace(created.ref, note("revised"));
    expect(edited.ref.revision).toBe(2);
    expect(() => first.read(created.ref)).toThrow("revision conflict");
    expect(new TextDecoder().decode(first.read(edited.ref).bytes)).toBe("revised");
    // Another module, and the presentation tools, are other editors.
    for (const other of ["custom:tool-b", "presentation"] as const)
      expect(() => first.replace(edited.ref, { ...note("bad"), owner: other })).toThrow(
        "another editor",
      );
  });

  it("types a file by its bytes, never by what the tool declared", () => {
    const files = workspace();
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
    expect(
      files.create({ name: "chart.png", mediaType: "image/png", bytes: text("<svg/>"), owner })
        .mediaType,
    ).toBe("application/octet-stream");
    expect(
      files.create({ name: "chart.bin", mediaType: "text/html", bytes: png, owner }).mediaType,
    ).toBe("image/png");
  });

  it("shares stored bytes instead of copying them on every read", () => {
    const files = workspace();
    const created = files.create(note("draft"));
    expect(files.read(created.ref).bytes).toBe(created.bytes);
  });

  it("publishes one revision at a time; a failed registration leaves the draft editable", () => {
    const files = workspace();
    const draft = files.create(note("one"));
    expect(files.preparePublish(draft.ref).state).toBe("pending");
    expect(() => files.preparePublish(draft.ref)).toThrow("already being published");
    expect(() => files.replace(draft.ref, note("two"))).toThrow("cannot be edited");
    files.finishPublish(draft.ref);
    const revised = files.replace(draft.ref, note("two"));
    files.preparePublish(revised.ref);
    files.finishPublish(revised.ref, "accepted-attachment");
    // Publishing it again names the attachment it became.
    expect(files.preparePublish(revised.ref)).toEqual({
      state: "published",
      attachmentId: "accepted-attachment",
    });
    expect(() => files.read(revised.ref)).toThrow("Open its attachment instead");
    expect(files.unfinished()).toHaveLength(0);
    expect(files.changes()).toEqual([]);
    expect(() => files.replace(revised.ref, note("three"))).toThrow("cannot be edited");
  });

  it("counts only files this answer creates, not the kept ones it continues", () => {
    const keptFiles = Array.from({ length: 8 }, (_, index) =>
      kept(`00000000-0000-4000-8000-00000000000${index}`, text(`${index}`)),
    );
    const files = workspace({ kept: keptFiles });
    for (let index = 0; index < 8; index += 1) files.create(note(`${index}`));
    expect(() => files.create(note("extra"))).toThrow("count limit");
    files.dispose();
    expect(() => files.read(keptFiles[0]!.ref)).toThrow("attempt has ended");
  });

  it("lets captures from the computer neither count nor crowd out other files", () => {
    const files = workspace();
    const capture = (size: number) =>
      files.create({
        name: "shot.png",
        mediaType: "image/png",
        bytes: new Uint8Array(size).fill(1),
        owner: "local",
        capture: true,
      });
    // Past the eight-file cap, captures still come.
    for (let index = 0; index < 8; index++) files.create(note(`draft ${index}`));
    const oldest = capture(MAX_ATTACHMENT_BYTES);
    const survivor = capture(MAX_ATTACHMENT_BYTES);
    capture(MAX_ATTACHMENT_BYTES);
    // A fourth full-size file only fits once the oldest capture makes room.
    const newest = capture(MAX_ATTACHMENT_BYTES);
    expect(() => files.read(oldest.ref)).toThrow("dropped to make room");
    expect(files.read(survivor.ref).ref).toEqual(survivor.ref);
    expect(files.read(newest.ref).ref).toEqual(newest.ref);
    // Nothing reminds the model to publish a capture, and none is kept.
    expect(files.unfinished().map((file) => file.name)).not.toContain("shot.png");
    expect(files.changes().map((file) => file.owner)).not.toContain("local");
  });

  it("continues a kept file, loading its bytes once and reporting what changed", async () => {
    const saved = text("kept");
    const loaded: string[] = [];
    const file = kept("11111111-1111-4111-8111-111111111111", saved);
    const files = workspace({
      kept: [file],
      load: async (target) => {
        loaded.push(target.attachmentId);
        return saved;
      },
    });
    expect(() => files.read(file.ref)).toThrow("not been loaded");
    await Promise.all([files.load(file.ref), files.load(file.ref)]);
    expect(loaded).toEqual([file.attachmentId]);
    expect(new TextDecoder().decode(files.read(file.ref).bytes)).toBe("kept");
    // Nothing changed yet, so nothing needs saving.
    expect(files.changes()).toEqual([]);

    files.replace(file.ref, {
      bytes: text("edited"),
      name: "deck.pptx",
      mediaType: "application/octet-stream",
      owner: "presentation",
    });
    files.create({ name: "photo.png", mediaType: "image/png", bytes: text("png"), owner: "local" });
    const [change] = files.changes();
    expect([change?.ref.revision, change?.owner]).toEqual([5, "presentation"]);
    // Until a save succeeds the revision stays pending; a stale revision clears nothing.
    files.markKept({ ...change!.ref, revision: 4 });
    expect(files.changes()).toHaveLength(1);
    files.markKept(change!.ref);
    expect(files.changes()).toEqual([]);
  });

  it("refuses kept bytes that no longer match their saved revision", async () => {
    const file = { ...kept("22222222-2222-4222-8222-222222222222", text("a")), fingerprint: "0" };
    const files = workspace({ kept: [file], load: async () => text("other") });
    await expect(files.load(file.ref)).rejects.toThrow("no longer matches");
  });
});
