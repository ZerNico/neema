import { Worker } from "node:worker_threads";
import { Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createWorkingFiles, type WorkingFiles } from "~/modules/chat/server/working-files.ts";
import {
  createPresentationRuntime,
  type PresentationJobs,
  type PresentationRuntime,
} from "~/modules/presentations/server/runtime.ts";
import { preparePresentationTools } from "~/modules/presentations/server/tools.ts";
import {
  createSpreadsheetRuntime,
  type SpreadsheetJobs,
} from "~/modules/spreadsheets/server/runtime.ts";
import { prepareSpreadsheetTools } from "~/modules/spreadsheets/server/tools.ts";
import { createWordRuntime, type WordJobs } from "~/modules/word/server/runtime.ts";
import { prepareWordTools } from "~/modules/word/server/tools.ts";
import type { JobHandlers } from "~/server/job-worker.ts";
import type { JobRequest, JobResult, JobRuntime } from "~/server/jobs.ts";
import type { PoolWorker } from "~/server/worker-pool.ts";
import { officeToolKit, type OfficeToolHost } from "./tool-kit.ts";
import { WordError } from "~/modules/word/errors.ts";

const source = `
const { parentPort, workerData } = require("node:worker_threads");
parentPort.on("message", (job) => {
  parentPort.postMessage({ id: job.id, entered: true });
  if (job.id === 1) Atomics.wait(new Int32Array(workerData), 0, 0);
  parentPort.postMessage({ id: job.id, ok: true, result: new Uint8Array([1]) });
});
`;

function transport() {
  const state = new SharedArrayBuffer(4);
  const entered = Promise.withResolvers<void>();
  const posted: Array<{ id: number }> = [];
  const workers: Worker[] = [];
  const exits: Promise<number>[] = [];
  const spawn = (): PoolWorker => {
    const worker = new Worker(source, { eval: true, workerData: state });
    workers.push(worker);
    exits.push(new Promise<number>((resolve) => worker.once("exit", resolve)));
    return {
      on: (event, listener) => {
        if (event === "message")
          worker.on("message", (reply) => {
            if (reply.entered) entered.resolve();
            else listener(reply);
          });
        else worker.on(event, listener);
      },
      postMessage: (message, transfer) => {
        posted.push(message as { id: number });
        worker.postMessage(message, transfer);
      },
      terminate: () => worker.terminate(),
    };
  };
  const release = () => {
    const words = new Int32Array(state);
    Atomics.store(words, 0, 1);
    Atomics.notify(words, 0);
  };
  return { spawn, entered: entered.promise, posted, workers, exits, release };
}

function delayedEdit() {
  const entered = Promise.withResolvers<AbortSignal>();
  const released = Promise.withResolvers<void>();
  const checked = Promise.withResolvers<void>();
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  const runtime = <H extends JobHandlers>(): JobRuntime<H> => ({
    close: async () => {},
    async run<R extends JobRequest<H>>(
      request: R,
      signal?: AbortSignal,
    ): Promise<JobResult<H, R["kind"]>> {
      calls.push(request.kind);
      if (!signal) throw new Error("Missing Office cancellation signal");
      signals.push(signal);
      if (request.kind === "create") return new Uint8Array([1]) as JobResult<H, R["kind"]>;
      entered.resolve(signal);
      await released.promise;
      const check = signal.throwIfAborted.bind(signal);
      vi.spyOn(signal, "throwIfAborted").mockImplementation(() => {
        checked.resolve();
        check();
      });
      return { bytes: new Uint8Array([2]), inspection: { slides: [] } } as JobResult<H, R["kind"]>;
    },
  });
  return {
    runtime,
    entered: entered.promise,
    release: released.resolve,
    checked: checked.promise,
    calls,
    signals,
  };
}

const cases = [
  {
    family: "word" as const,
    extension: "docx",
    edit: "edit_word_file",
    inspect: "inspect_word_file",
    prepare(
      host: OfficeToolHost,
      spawn?: () => PoolWorker,
      delayed?: ReturnType<typeof delayedEdit>,
    ) {
      const runtime =
        delayed?.runtime<WordJobs>() ??
        createWordRuntime(new URL("../../word/server/runtime-worker.ts", import.meta.url), {
          workers: 1,
          ...(spawn ? { spawn } : {}),
        });
      return {
        ...prepareWordTools({ ...host, runtime }),
        close: runtime.close,
        create: (signal?: AbortSignal) => runtime.run({ kind: "create" }, signal),
      };
    },
  },
  {
    family: "spreadsheet" as const,
    extension: "xlsx",
    edit: "edit_spreadsheet",
    inspect: "inspect_spreadsheet",
    prepare(
      host: OfficeToolHost,
      spawn?: () => PoolWorker,
      delayed?: ReturnType<typeof delayedEdit>,
    ) {
      const runtime =
        delayed?.runtime<SpreadsheetJobs>() ??
        createSpreadsheetRuntime(
          new URL("../../spreadsheets/server/runtime-worker.ts", import.meta.url),
          { workers: 1, ...(spawn ? { spawn } : {}) },
        );
      return {
        ...prepareSpreadsheetTools({ ...host, runtime }),
        close: runtime.close,
        create: (signal?: AbortSignal) => runtime.run({ kind: "create" }, signal),
      };
    },
  },
  {
    family: "presentation" as const,
    extension: "pptx",
    edit: "edit_presentation",
    inspect: "inspect_presentation",
    prepare(
      host: OfficeToolHost,
      spawn?: () => PoolWorker,
      delayed?: ReturnType<typeof delayedEdit>,
    ) {
      const runtime =
        delayed?.runtime<PresentationJobs>() ??
        createPresentationRuntime(
          new URL("../../presentations/server/runtime-worker.ts", import.meta.url),
          { workers: 1, ...(spawn ? { spawn } : {}) },
        );
      return {
        ...preparePresentationTools({ ...host, runtime }),
        close: runtime.close,
        create: (signal?: AbortSignal) => runtime.run({ kind: "create" }, signal),
      };
    },
  },
];

const handler = (group: { handlers: Record<string, unknown> }, name: string, raw: unknown) =>
  (group.handlers[name] as (raw: unknown) => Effect.Effect<unknown>)(raw);
const host = (workingFiles: WorkingFiles): OfficeToolHost => ({
  workingFiles,
  resolveFile: () => Effect.fail("Not available"),
});

describe("Office cancellation boundaries", () => {
  it("keeps workspace disposal as an independent draft guard", () => {
    const workingFiles = createWorkingFiles();
    const kit = officeToolKit("word", host(workingFiles), WordError);
    const signal = new AbortController().signal;
    const draft = kit.saveDraft(null, new Uint8Array([1]), "Draft.docx", signal);
    workingFiles.dispose();
    expect(() => kit.saveDraft(null, new Uint8Array([2]), "New.docx", signal)).toThrow(
      "attempt has ended",
    );
    expect(() =>
      kit.saveDraft(
        { bytes: new Uint8Array([1]), name: "Draft.docx", ref: draft.snapshot.ref, draft: true },
        new Uint8Array([2]),
        "Draft.docx",
        signal,
      ),
    ).toThrow("attempt has ended");
  });

  it("cancels a nested presentation render without undoing the completed draft edit", async () => {
    const workingFiles = createWorkingFiles();
    const entered = Promise.withResolvers<AbortSignal>();
    const released = Promise.withResolvers<void>();
    const checked = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    const calls: string[] = [];
    const runtime: PresentationRuntime = {
      close: async () => {},
      async run<R extends JobRequest<PresentationJobs>>(
        request: R,
        signal?: AbortSignal,
      ): Promise<JobResult<PresentationJobs, R["kind"]>> {
        if (!signal) throw new Error("Missing Office cancellation signal");
        signals.push(signal);
        calls.push(request.kind);
        let result: unknown;
        if (request.kind === "create") result = new Uint8Array([1]);
        else if (request.kind === "edit")
          result = {
            bytes: new Uint8Array([2]),
            inspection: { slides: [], templateOwners: [] },
            changedSlideIds: [1],
            overflow: [],
            overflowSummary: { total: 0, counts: { new: 0, increased: 0, uncompared: 0 } },
            refs: { slides: {}, shapes: {} },
          };
        else {
          entered.resolve(signal);
          await released.promise;
          const check = signal.throwIfAborted.bind(signal);
          vi.spyOn(signal, "throwIfAborted").mockImplementation(() => {
            checked.resolve();
            check();
          });
          result = [];
        }
        return result as JobResult<PresentationJobs, R["kind"]>;
      },
    };
    const preview = vi.fn(async () => {});
    const { group } = preparePresentationTools({
      ...host(workingFiles),
      runtime,
      onPreview: preview,
    });
    const fiber = Effect.runFork(
      handler(group, "edit_presentation", { create: true, operations: [], renderSlideIds: [1] }),
    );
    try {
      const signal = await entered.promise;
      const [draft] = workingFiles.changes();
      expect(draft).toMatchObject({
        owner: "presentation",
        bytes: new Uint8Array([2]),
        ref: { revision: 1 },
      });
      await Effect.runPromise(Fiber.interrupt(fiber));
      expect(signal.aborted).toBe(true);
      released.resolve();
      await checked.promise;
      expect(preview).not.toHaveBeenCalled();
      expect(calls).toEqual(["create", "edit", "render"]);
      expect(new Set(signals).size).toBe(1);
      expect(workingFiles.read(draft!.ref).bytes).toEqual(new Uint8Array([2]));
    } finally {
      released.resolve();
      await Effect.runPromise(Fiber.interrupt(fiber));
      workingFiles.dispose();
      vi.restoreAllMocks();
    }
  });
});

describe.each(cases)("$family Office cancellation", (family) => {
  it("passes interruption to the active worker and awaits that worker's exit", async () => {
    const worker = transport();
    const workingFiles = createWorkingFiles();
    const create = vi.spyOn(workingFiles, "create");
    const tools = family.prepare(host(workingFiles), worker.spawn);
    const fiber = Effect.runFork(
      handler(tools.group, family.edit, { create: true, operations: [] }),
    );
    try {
      await worker.entered;
      await Effect.runPromise(Fiber.interrupt(fiber));
      await worker.exits[0];
      expect(create).not.toHaveBeenCalled();
      expect(worker.workers).toHaveLength(1);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await tools.close();
      await Promise.all(worker.exits);
      workingFiles.dispose();
    }
  });

  it("removes a cancelled pool wait without retiring the worker serving another job", async () => {
    const worker = transport();
    const workingFiles = createWorkingFiles();
    const tools = family.prepare(host(workingFiles), worker.spawn);
    const held = tools.create();
    await worker.entered;
    const queued = Promise.withResolvers<void>();
    // The pool's abort subscription acknowledges admission into the waiting lane.
    const original = AbortSignal.prototype.addEventListener;
    const subscribed = vi
      .spyOn(AbortSignal.prototype, "addEventListener")
      .mockImplementation(function (this: AbortSignal, ...args) {
        if (args[0] === "abort") queued.resolve();
        original.apply(this, args);
      });
    const fiber = Effect.runFork(
      handler(tools.group, family.edit, { create: true, operations: [] }),
    );
    try {
      await queued.promise;
      subscribed.mockRestore();
      await Effect.runPromise(Fiber.interrupt(fiber));
      expect(worker.posted).toHaveLength(1);
      worker.release();
      await expect(held).resolves.toEqual(new Uint8Array([1]));
      await expect(tools.create()).resolves.toEqual(new Uint8Array([1]));
      expect(worker.posted).toHaveLength(2);
      expect(worker.posted.map((message) => message.id)).toEqual([1, 3]);
      expect(worker.workers).toHaveLength(1);
    } finally {
      subscribed.mockRestore();
      worker.release();
      await Effect.runPromise(Fiber.interrupt(fiber));
      await tools.close();
      await Promise.all(worker.exits);
      await held.catch(() => {});
      workingFiles.dispose();
    }
  });

  it.each([false, true])(
    "checks cancellation before a delayed successful edit mutates a draft (replace %s)",
    async (replace) => {
      const workingFiles = createWorkingFiles();
      const existing = replace
        ? workingFiles.create({
            bytes: new Uint8Array([1]),
            name: `Draft.${family.extension}`,
            mediaType: "application/octet-stream",
            owner: family.family,
          })
        : null;
      const create = vi.spyOn(workingFiles, "create");
      const replaceDraft = vi.spyOn(workingFiles, "replace");
      const delayed = delayedEdit();
      const tools = family.prepare(host(workingFiles), undefined, delayed);
      const raw = existing
        ? { workingRef: `working:${existing.ref.id}@1`, operations: [] }
        : { create: true, operations: [] };
      const fiber = Effect.runFork(handler(tools.group, family.edit, raw));
      try {
        const signal = await delayed.entered;
        await Effect.runPromise(Fiber.interrupt(fiber));
        expect(signal.aborted).toBe(true);
        delayed.release();
        await delayed.checked;
        expect(create).not.toHaveBeenCalled();
        expect(replaceDraft).not.toHaveBeenCalled();
        expect(delayed.calls).toEqual(existing ? ["edit"] : ["create", "edit"]);
        expect(new Set(delayed.signals).size).toBe(1);
        if (existing) expect(workingFiles.read(existing.ref).bytes).toEqual(new Uint8Array([1]));
      } finally {
        delayed.release();
        await Effect.runPromise(Fiber.interrupt(fiber));
        await tools.close();
        workingFiles.dispose();
        vi.restoreAllMocks();
      }
    },
  );

  it("interrupts the independently run source resolver before worker admission", async () => {
    const workingFiles = createWorkingFiles();
    const started = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const worker = transport();
    const tools = family.prepare(
      {
        workingFiles,
        resolveFile: () =>
          Effect.sync(started.resolve).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(stopped.resolve)),
          ),
      },
      worker.spawn,
    );
    const fiber = Effect.runFork(
      handler(tools.group, family.inspect, {
        sourceRef: "attachment:01990f4e-6650-7a33-a768-611e2e4bf4c7",
      }),
    );
    try {
      await started.promise;
      await Effect.runPromise(Fiber.interrupt(fiber));
      await stopped.promise;
      expect(worker.posted).toHaveLength(0);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await tools.close();
      await Promise.all(worker.exits);
      workingFiles.dispose();
    }
  });
});
