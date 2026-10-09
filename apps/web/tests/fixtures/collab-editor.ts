import { Node } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { Step } from "@tiptap/pm/transform";
import { Effect, Option, Stream } from "effect";
import { collab, getVersion, receiveTransaction, sendableSteps } from "prosemirror-collab";
import { uuidv7 } from "uuidv7";
import {
  documentSchema,
  parseMarkdown,
  replaceDifference,
  toMarkdown,
} from "~/modules/documents/editor/markdown.ts";
import type { DocumentFrame, PushDocumentResult } from "~/modules/documents/schema.ts";
import { DocumentService } from "~/modules/documents/server/document-service.ts";

type Run = <A, E>(effect: Effect.Effect<A, E, DocumentService>) => Promise<A>;

/**
 * A person's editor without a browser: a collab editor state fed by the
 * service's own feed, making changes as the smallest edit and pushing them
 * like the panel does, rebasing over whatever landed first when refused.
 */
export async function collabEditor(run: Run, userId: string, documentId: string) {
  const clientId = uuidv7();
  const firstFrame = (revision: number | null) =>
    run(
      Effect.gen(function* () {
        const service = yield* DocumentService;
        const feed = yield* service.subscribe(userId, documentId, { revision, clientId });
        if (!feed) return null;
        return Option.getOrThrow(yield* Stream.runHead(feed)) as DocumentFrame;
      }),
    );
  const opened = await firstFrame(null);
  if (!opened) return null;
  if (opened.type !== "reset") throw new Error(`expected reset, got ${opened.type}`);
  let state = EditorState.create({
    doc: Node.fromJSON(documentSchema, opened.doc),
    plugins: [collab({ version: opened.revision, clientID: clientId })],
  });
  const receive = (frame: Extract<DocumentFrame, { type: "steps" }>) => {
    const skip = getVersion(state) - (frame.revision - frame.steps.length);
    const steps = frame.steps.slice(skip).map((json) => Step.fromJSON(documentSchema, json));
    state = state.apply(receiveTransaction(state, steps, frame.clientIds.slice(skip)));
  };

  /** Steps that landed since this editor last heard, rebasing its own unsent ones over them. */
  const catchUp = async () => {
    const frame = await firstFrame(getVersion(state));
    if (frame?.type !== "steps") throw new Error(`expected steps, got ${frame?.type}`);
    receive(frame);
  };
  /** Sends the unsent steps once; refused ones stay unsent. */
  const push = async (): Promise<PushDocumentResult> => {
    const sendable = sendableSteps(state);
    if (!sendable) return { revision: getVersion(state), conflict: false };
    const result = await run(
      Effect.flatMap(DocumentService, (service) =>
        service.push(userId, {
          documentId,
          clientId,
          revision: sendable.version,
          steps: sendable.steps.map((step) => JSON.stringify(step.toJSON())),
        }),
      ),
    );
    if (!result.conflict)
      receive({
        type: "steps",
        steps: sendable.steps.map((step) => step.toJSON() as Record<string, unknown>),
        clientIds: sendable.steps.map(() => clientId),
        revision: result.revision,
      });
    return result;
  };
  /** Changes the text locally, as typing would, without sending it. */
  const change = (edit: (markdown: string) => string) => {
    state = state.apply(replaceDifference(state.tr, parseMarkdown(edit(toMarkdown(state.doc)))));
  };
  /** Changes and sends, rebasing and resending as the panel does until the server takes it. */
  const type = async (edit: (markdown: string) => string) => {
    change(edit);
    for (let attempt = 0; attempt < 5; attempt++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each attempt rebases over the one before.
      const result = await push();
      if (!result.conflict) return { revision: result.revision };
      // oxlint-disable-next-line eslint/no-await-in-loop -- The next attempt needs these steps.
      await catchUp();
    }
    throw new Error("the server kept refusing this editor's steps");
  };
  /** Marks the first occurrence of `words` with a comment thread, as the panel does, and sends it. */
  const mark = async (words: string, thread: string) => {
    let from = -1;
    state.doc.descendants((node, position) => {
      if (from === -1 && node.isText && node.text!.includes(words))
        from = position + node.text!.indexOf(words);
      return from === -1;
    });
    if (from === -1) throw new Error(`no "${words}" in the document`);
    state = state.apply(
      state.tr.addMark(from, from + words.length, documentSchema.marks.comment!.create({ thread })),
    );
    const result = await push();
    if (result.conflict) throw new Error("the comment mark was refused");
  };
  return {
    clientId,
    mark,
    markdown: () => toMarkdown(state.doc),
    revision: () => getVersion(state),
    unsent: () => sendableSteps(state)?.steps.length ?? 0,
    change,
    push,
    catchUp,
    type,
  };
}
