import { serializeChartSvg } from "@tanstack/charts/export";

const escape = (text: string) => text.replace(/[<>&"]/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * A drawn chart as one SVG file. The library exports only its plot, while the
 * title and legend are the page's own, so those are redrawn where they stand,
 * in the colours and type the reader sees.
 */
export function chartSvg(figure: HTMLElement): string {
  const view = figure.ownerDocument.defaultView!;
  const frame = figure.getBoundingClientRect();
  const style = view.getComputedStyle(figure);
  const parts: string[] = [`<rect width="100%" height="100%" fill="${style.backgroundColor}"/>`];
  for (const element of figure.querySelectorAll<HTMLElement>("[data-export]")) {
    const box = element.getBoundingClientRect();
    const [x, y] = [box.left - frame.left, box.top - frame.top];
    const own = view.getComputedStyle(element);
    const opacity = view.getComputedStyle(element.closest("button") ?? element).opacity;
    if (element.dataset.export === "swatch")
      parts.push(
        `<circle cx="${x + box.width / 2}" cy="${y + box.height / 2}" r="${box.width / 2}" fill="${own.backgroundColor}" opacity="${opacity}"/>`,
      );
    else if (element.dataset.export === "text")
      parts.push(
        `<text x="${x}" y="${y + box.height / 2}" dominant-baseline="central" fill="${own.color}" font-family="${escape(own.fontFamily)}" font-size="${own.fontSize}" font-weight="${own.fontWeight}" opacity="${opacity}">${escape(element.textContent ?? "")}</text>`,
      );
  }
  const plot = figure.querySelector<SVGSVGElement>("svg.ts-chart");
  if (plot) {
    const box = plot.getBoundingClientRect();
    const inner = serializeChartSvg(plot, { width: box.width, height: box.height });
    parts.push(
      `<g transform="translate(${box.left - frame.left} ${box.top - frame.top})">${inner}</g>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}" viewBox="0 0 ${frame.width} ${frame.height}">${parts.join("")}</svg>`;
}

/** The chart drawn as a PNG, at twice its size on screen so it stays sharp. */
export async function chartPng(figure: HTMLElement): Promise<Blob> {
  const svg = chartSvg(figure);
  const { width, height } = figure.getBoundingClientRect();
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * 2);
    canvas.height = Math.round(height * 2);
    const context = canvas.getContext("2d")!;
    context.scale(2, 2);
    context.drawImage(image, 0, 0, width, height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("No image"))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A file name from a chart's title, safe on every system. */
export const chartFileName = (title: string | undefined, extension: string) =>
  `${(title ?? "Chart").replace(/[\\/:*?"<>|]+/g, " ").trim() || "Chart"}.${extension}`;
