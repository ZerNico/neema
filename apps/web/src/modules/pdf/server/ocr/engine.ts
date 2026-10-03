// Loaded by the PDF worker under plain Node in development: relative imports only.
import { readFile } from "node:fs/promises";
import type { InferenceSession, Tensor } from "onnxruntime-node";
import { parse } from "yaml";
import {
  boxScore,
  miniBox,
  orderClockwise,
  readingOrder,
  regions,
  unclip,
  type Point,
  type Quad,
} from "./geometry.ts";
import { cropQuad, resize, writeTensor, type RgbImage } from "./image.ts";

/**
 * The detector and recognizer's settings, RapidOCR's defaults for PP-OCRv6:
 * the reference this port is measured against, not the model card's values.
 */
const DETECTION = {
  limitSideLen: 736,
  thresh: 0.3,
  boxThresh: 0.5,
  maxCandidates: 1000,
  unclipRatio: 1.6,
  minSize: 3,
} as const;
const RECOGNITION = { height: 48, width: 320, batch: 6, minScore: 0.5 } as const;

export interface OcrModelPaths {
  readonly detection: string;
  readonly recognition: string;
  /** The recognizer's `inference.yml`, whose `character_dict` is the alphabet. */
  readonly recognitionConfig: string;
}

export interface OcrEngine {
  read(image: RgbImage): Promise<string>;
}

/** The alphabet with CTC's blank first and a space last, as the recognizer was trained. */
export async function loadAlphabet(path: string) {
  const config = parse(await readFile(path, "utf8")) as {
    PostProcess?: { character_dict?: unknown };
  };
  const characters = config.PostProcess?.character_dict;
  if (!Array.isArray(characters) || characters.length === 0)
    throw new Error("The recognition model's alphabet is missing.");
  return ["", ...characters.map(String), " "];
}

const run = async (session: InferenceSession, input: Tensor) => {
  const outputs = await session.run({ [session.inputNames[0]!]: input });
  return outputs[session.outputNames[0]!]!;
};

export async function createOcrEngine(
  ort: typeof import("onnxruntime-node"),
  paths: OcrModelPaths,
  threads: number,
): Promise<OcrEngine> {
  // Without explicit threads ONNX Runtime sizes its pools to the host, not the
  // container, and a page took fifteen to thirty times longer.
  const options: InferenceSession.SessionOptions = {
    executionProviders: ["cpu"],
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    graphOptimizationLevel: "all",
    enableCpuMemArena: false,
  };
  const [detector, recognizer, alphabet] = await Promise.all([
    ort.InferenceSession.create(paths.detection, options),
    ort.InferenceSession.create(paths.recognition, options),
    loadAlphabet(paths.recognitionConfig),
  ]);

  const detect = async (image: RgbImage): Promise<Quad[]> => {
    const shortSide = Math.min(image.width, image.height);
    const ratio = shortSide < DETECTION.limitSideLen ? DETECTION.limitSideLen / shortSide : 1;
    const width = Math.max(32, Math.round(Math.trunc(image.width * ratio) / 32) * 32);
    const height = Math.max(32, Math.round(Math.trunc(image.height * ratio) / 32) * 32);
    const input = new Float32Array(3 * width * height);
    writeTensor(resize(image, width, height), input);
    const output = await run(detector, new ort.Tensor("float32", input, [1, 3, height, width]));
    const map = output.data as Float32Array;
    const [mapHeight, mapWidth] = output.dims.slice(-2) as [number, number];
    const mask = new Uint8Array(mapWidth * mapHeight);
    // A 2x2 dilation, as the reference applies before tracing regions.
    for (let y = 0; y < mapHeight; y++)
      for (let x = 0; x < mapWidth; x++) {
        const on = (px: number, py: number) =>
          px >= 0 && py >= 0 && map[py * mapWidth + px]! > DETECTION.thresh;
        if (on(x, y) || on(x - 1, y) || on(x, y - 1) || on(x - 1, y - 1))
          mask[y * mapWidth + x] = 1;
      }
    const boxes: Quad[] = [];
    for (const edge of regions(mask, mapWidth, mapHeight, DETECTION.maxCandidates)) {
      const first = miniBox(edge);
      if (first.shortSide < DETECTION.minSize) continue;
      if (boxScore(map, mapWidth, mapHeight, first.box) < DETECTION.boxThresh) continue;
      const grown = miniBox(unclip(first.box, DETECTION.unclipRatio));
      if (grown.shortSide < DETECTION.minSize + 2) continue;
      const scaled = mapQuad(grown.box, ([x, y]) => [
        Math.min(Math.max(Math.round((x / mapWidth) * image.width), 0), image.width),
        Math.min(Math.max(Math.round((y / mapHeight) * image.height), 0), image.height),
      ]);
      const ordered = mapQuad(orderClockwise(scaled), ([x, y]) => [
        Math.trunc(Math.min(Math.max(x, 0), image.width - 1)),
        Math.trunc(Math.min(Math.max(y, 0), image.height - 1)),
      ]);
      const boxWidth = Math.trunc(
        Math.hypot(ordered[0][0] - ordered[1][0], ordered[0][1] - ordered[1][1]),
      );
      const boxHeight = Math.trunc(
        Math.hypot(ordered[0][0] - ordered[3][0], ordered[0][1] - ordered[3][1]),
      );
      if (boxWidth <= 3 || boxHeight <= 3) continue;
      boxes.push(ordered);
    }
    return boxes;
  };

  /** Each line's text and mean confidence, in the order given. */
  const recognize = async (lines: readonly RgbImage[]) => {
    const results: Array<{ text: string; score: number }> = Array.from({ length: lines.length });
    // Similar widths batch together, so less of each batch is padding.
    const order = lines
      .map((line, index) => ({ index, ratio: line.width / line.height }))
      .toSorted((a, b) => a.ratio - b.ratio);
    for (let start = 0; start < order.length; start += RECOGNITION.batch) {
      const batch = order.slice(start, start + RECOGNITION.batch);
      const maxRatio = Math.max(
        RECOGNITION.width / RECOGNITION.height,
        ...batch.map((b) => b.ratio),
      );
      const width = Math.trunc(RECOGNITION.height * maxRatio);
      const plane = RECOGNITION.height * width;
      const input = new Float32Array(batch.length * 3 * plane);
      batch.forEach(({ index, ratio }, slot) => {
        const resizedWidth = Math.min(width, Math.ceil(RECOGNITION.height * ratio));
        writeTensor(
          resize(lines[index]!, resizedWidth, RECOGNITION.height),
          input,
          slot * 3 * plane,
          width,
        );
      });
      // oxlint-disable-next-line no-await-in-loop -- batches run in turn, each using every thread
      const output = await run(
        recognizer,
        new ort.Tensor("float32", input, [batch.length, 3, RECOGNITION.height, width]),
      );
      const [, steps, classes] = output.dims as [number, number, number];
      const probabilities = output.data as Float32Array;
      batch.forEach(({ index }, slot) => {
        let text = "";
        const scores: number[] = [];
        let previous = -1;
        for (let step = 0; step < steps; step++) {
          const base = (slot * steps + step) * classes;
          let best = 0;
          for (let k = 1; k < classes; k++)
            if (probabilities[base + k]! > probabilities[base + best]!) best = k;
          // CTC: a repeat of the last step is one character; class 0 is blank.
          if (best !== 0 && best !== previous) {
            text += alphabet[best] ?? "";
            scores.push(probabilities[base + best]!);
          }
          previous = best;
        }
        results[index] = {
          text,
          score: scores.length === 0 ? 0 : scores.reduce((a, b) => a + b, 0) / scores.length,
        };
      });
    }
    return results;
  };

  return {
    async read(image) {
      const boxes = readingOrder((await detect(image)).map((box) => ({ box })));
      if (boxes.length === 0) return "";
      const texts = await recognize(boxes.map(({ box }) => cropQuad(image, box)));
      const kept = boxes
        .map(({ box }, index) => ({ box, ...texts[index]! }))
        .filter((line) => line.score >= RECOGNITION.minScore && line.text.trim() !== "");
      return joinLines(kept);
    },
  };
}

const mapQuad = (quad: Quad, f: (point: Point) => Point): Quad => [
  f(quad[0]),
  f(quad[1]),
  f(quad[2]),
  f(quad[3]),
];

/**
 * Boxes on one visual line, by overlapping vertical extent, joined with
 * spaces; lines with newlines. A form's fields then read as rows, not as one word a line.
 */
export function joinLines(items: ReadonlyArray<{ box: Quad; text: string }>) {
  const rows: Array<{ top: number; bottom: number; parts: Array<{ x: number; text: string }> }> =
    [];
  for (const item of items) {
    const top = Math.min(...item.box.map((p) => p[1]));
    const bottom = Math.max(...item.box.map((p) => p[1]));
    const x = Math.min(...item.box.map((p) => p[0]));
    const row = rows.find((candidate) => {
      const overlap = Math.min(bottom, candidate.bottom) - Math.max(top, candidate.top);
      return overlap > 0.5 * Math.min(bottom - top, candidate.bottom - candidate.top);
    });
    if (row) {
      row.parts.push({ x, text: item.text.trim() });
      row.top = Math.min(row.top, top);
      row.bottom = Math.max(row.bottom, bottom);
    } else rows.push({ top, bottom, parts: [{ x, text: item.text.trim() }] });
  }
  return rows
    .toSorted((a, b) => a.top - b.top)
    .map((row) =>
      row.parts
        .toSorted((a, b) => a.x - b.x)
        .map((part) => part.text)
        .join(" "),
    )
    .join("\n");
}
