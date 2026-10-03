import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Config, Context, Effect, Layer } from "effect";
import type { OcrModelPaths } from "./ocr/engine.ts";

export type OcrQuality = "accurate" | "fast";

interface PinnedFile {
  readonly name: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

const huggingFace = (repo: string, revision: string, file: string) =>
  `https://huggingface.co/PaddlePaddle/${repo}/resolve/${revision}/${file}`;

/**
 * PP-OCRv6 (Apache-2.0) from PaddlePaddle's own repositories, pinned to a
 * revision and a hash: the hash is what makes the download trustworthy, since
 * the files are fetched through whichever CDN the hub redirects to.
 */
const VARIANTS: Record<OcrQuality, { readonly id: string; readonly files: readonly PinnedFile[] }> =
  {
    accurate: {
      id: "ppocrv6-small",
      files: [
        {
          name: "det.onnx",
          url: huggingFace(
            "PP-OCRv6_small_det_onnx",
            "28fe5895c24fd108c19eb3e8479f4ab385fbfc62",
            "inference.onnx",
          ),
          sha256: "d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e",
          bytes: 9_880_512,
        },
        {
          name: "rec.onnx",
          url: huggingFace(
            "PP-OCRv6_small_rec_onnx",
            "b8f84f0b80c529de40b4fbb3544b84fa7233a513",
            "inference.onnx",
          ),
          sha256: "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634",
          bytes: 21_159_378,
        },
        {
          name: "rec.yml",
          url: huggingFace(
            "PP-OCRv6_small_rec_onnx",
            "b8f84f0b80c529de40b4fbb3544b84fa7233a513",
            "inference.yml",
          ),
          sha256: "ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1",
          bytes: 150_579,
        },
      ],
    },
    fast: {
      id: "ppocrv6-tiny",
      files: [
        {
          name: "det.onnx",
          url: huggingFace(
            "PP-OCRv6_tiny_det_onnx",
            "2ba1506c0380b8f0b03dd142459aac66d4421f6c",
            "inference.onnx",
          ),
          sha256: "193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8",
          bytes: 1_780_590,
        },
        {
          name: "rec.onnx",
          url: huggingFace(
            "PP-OCRv6_tiny_rec_onnx",
            "2612ab37152ae0a677521bae4e1e3d4fb4cf7c30",
            "inference.onnx",
          ),
          sha256: "9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6",
          bytes: 4_462_639,
        },
        {
          name: "rec.yml",
          url: huggingFace(
            "PP-OCRv6_tiny_rec_onnx",
            "2612ab37152ae0a677521bae4e1e3d4fb4cf7c30",
            "inference.yml",
          ),
          sha256: "66170210bad538e83fff3c4a3867e547d6bf20b50d64b20347c4b913f3034ea1",
          bytes: 55_571,
        },
      ],
    },
  };

/** The fingerprint part naming which files read a page, so a change re-reads it. */
export const ocrVariantId = (quality: OcrQuality) => VARIANTS[quality].id;

/** Platforms onnxruntime-node ships a CPU binary for. */
const SUPPORTED = new Set(["linux-x64", "linux-arm64", "darwin-arm64", "win32-x64", "win32-arm64"]);

export type OcrModelStatus =
  | { readonly state: "unsupported" }
  | { readonly state: "missing" }
  | { readonly state: "downloading"; readonly done: number; readonly total: number }
  | { readonly state: "failed"; readonly error: string }
  | { readonly state: "ready" };

const ALLOWED_HOST = /(^|\.)(huggingface\.co|hf\.co)$/;
/** A download stalled this long fails; a slow but moving one does not. */
const IDLE_TIMEOUT_MS = 60_000;

/**
 * Fetches `file` to `target`, following redirects only within the hub, hashing
 * as it streams and refusing anything longer than the pinned size. The file
 * appears under its name only once its hash matches.
 */
async function download(
  file: PinnedFile,
  target: string,
  progress: (bytes: number) => void,
  stop: AbortSignal,
) {
  const idle = new AbortController();
  let timer = setTimeout(() => idle.abort(), IDLE_TIMEOUT_MS);
  const moved = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), IDLE_TIMEOUT_MS);
  };
  const signal = AbortSignal.any([stop, idle.signal]);
  try {
    await fetchInto(file, target, progress, signal, moved);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchInto(
  file: PinnedFile,
  target: string,
  progress: (bytes: number) => void,
  signal: AbortSignal,
  moved: () => void,
) {
  let url = file.url;
  let response: Response | null = null;
  for (let hop = 0; hop < 6; hop++) {
    const host = new URL(url).hostname;
    if (new URL(url).protocol !== "https:" || !ALLOWED_HOST.test(host))
      throw new Error(`refused a redirect to ${host}`);
    // oxlint-disable-next-line no-await-in-loop -- redirects are followed in order
    const next = await fetch(url, {
      redirect: "manual",
      signal,
    });
    const location = next.headers.get("location");
    if (next.status >= 300 && next.status < 400 && location) {
      void next.body?.cancel();
      url = new URL(location, url).toString();
      continue;
    }
    if (!next.ok) {
      void next.body?.cancel();
      throw new Error(`the download answered ${next.status}`);
    }
    response = next;
    break;
  }
  if (!response?.body) throw new Error("too many redirects");
  // Its own partial file: a second process (a dev reload) can never write into this one.
  const partial = `${target}.${randomUUID()}.part`;
  const handle = await open(partial, "w");
  const hash = createHash("sha256");
  let written = 0;
  try {
    try {
      for await (const chunk of response.body) {
        moved();
        written += chunk.byteLength;
        if (written > file.bytes) throw new Error("the file is larger than expected");
        hash.update(chunk);
        await handle.write(chunk);
        progress(chunk.byteLength);
      }
    } finally {
      await handle.close();
    }
    if (written !== file.bytes || hash.digest("hex") !== file.sha256)
      throw new Error("the downloaded file did not match its checksum");
    await rename(partial, target);
  } finally {
    await rm(partial, { force: true });
  }
}

async function matches(path: string, file: PinnedFile) {
  const info = await stat(path).catch(() => null);
  if (!info || info.size !== file.bytes) return false;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex") === file.sha256;
}

/**
 * The recognition files for reading scans on this server. They are fetched
 * when an admin turns the option on, never shipped with the app, and checked
 * against pinned hashes once a process; progress and the last failure live in
 * memory, so a restart simply checks the disk again.
 */
export class OcrModels extends Context.Service<
  OcrModels,
  {
    status(quality: OcrQuality): Effect.Effect<OcrModelStatus>;
    /** Starts fetching `quality`'s files unless they are ready or already coming. */
    ensure(quality: OcrQuality): Effect.Effect<void>;
    /** The files' paths once ready, else null: a reader never waits on a download. */
    paths(quality: OcrQuality): Effect.Effect<OcrModelPaths | null>;
  }
>()("chat/pdf/OcrModels") {
  static readonly layer = Layer.effect(
    OcrModels,
    Effect.gen(function* () {
      const root = resolve(
        yield* Config.String("OCR_MODEL_ROOT").pipe(
          Config.withDefault(".data/ocr-models"),
          Effect.orDie,
        ),
      );
      const scope = yield* Effect.scope;
      const supported = SUPPORTED.has(`${process.platform}-${process.arch}`);
      const verified = new Set<OcrQuality>();
      const running = new Map<OcrQuality, { done: number; total: number }>();
      const failures = new Map<OcrQuality, string>();

      const directory = (quality: OcrQuality) => join(root, VARIANTS[quality].id);
      const verifyNow = async (quality: OcrQuality) => {
        if (verified.has(quality)) return true;
        for (const file of VARIANTS[quality].files)
          // oxlint-disable-next-line no-await-in-loop -- three files, checked in turn
          if (!(await matches(join(directory(quality), file.name), file))) return false;
        verified.add(quality);
        return true;
      };
      const verify = (quality: OcrQuality) => Effect.promise(() => verifyNow(quality));

      const status = Effect.fn("OcrModels.status")(function* (quality: OcrQuality) {
        if (!supported) return { state: "unsupported" } as const;
        const progress = running.get(quality);
        if (progress)
          return { state: "downloading", done: progress.done, total: progress.total } as const;
        if (yield* verify(quality)) return { state: "ready" } as const;
        const error = failures.get(quality);
        return error ? ({ state: "failed", error } as const) : ({ state: "missing" } as const);
      });

      const ensure = Effect.fn("OcrModels.ensure")(function* (quality: OcrQuality) {
        if (!supported || running.has(quality)) return;
        const files = VARIANTS[quality].files;
        const progress = {
          done: 0,
          total: files.reduce((sum, file) => sum + file.bytes, 0),
        };
        // Reserved before anything is awaited, so two callers never fetch into one file.
        running.set(quality, progress);
        failures.delete(quality);
        const work = Effect.tryPromise({
          // Checking inside the work means whatever happens, `running` is released below.
          try: async (signal) => {
            if (await verifyNow(quality)) return;
            await mkdir(directory(quality), { recursive: true });
            for (const file of files) {
              const target = join(directory(quality), file.name);
              // oxlint-disable-next-line no-await-in-loop -- one file at a time
              if (await matches(target, file)) {
                progress.done += file.bytes;
                continue;
              }
              // oxlint-disable-next-line no-await-in-loop -- see above
              await download(
                file,
                target,
                (bytes) => {
                  progress.done += bytes;
                },
                signal,
              );
            }
          },
          catch: (error) => (error instanceof Error ? error.message : "the download failed"),
        }).pipe(
          Effect.tap(() => Effect.sync(() => verified.add(quality))),
          Effect.catch((error) => Effect.sync(() => void failures.set(quality, error))),
          Effect.ensuring(Effect.sync(() => running.delete(quality))),
        );
        // The layer's scope owns it: a reload or shutdown stops the download.
        yield* Effect.forkIn(work, scope);
      });

      const paths = Effect.fn("OcrModels.paths")(function* (quality: OcrQuality) {
        if (!supported || running.has(quality) || !(yield* verify(quality))) return null;
        const at = (name: string) => join(directory(quality), name);
        return {
          detection: at("det.onnx"),
          recognition: at("rec.onnx"),
          recognitionConfig: at("rec.yml"),
        } satisfies OcrModelPaths;
      });

      return OcrModels.of({ status, ensure, paths });
    }),
  );
}
