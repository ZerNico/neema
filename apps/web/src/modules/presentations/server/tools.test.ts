import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { createPresentationDraft, editPresentation } from "./adapter.ts";
import { readPresentationArchive } from "./archive.ts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createWorkingFiles } from "~/modules/chat/server/working-files.ts";
import { Tool } from "effect/ai";
import { createPresentationRuntime } from "./runtime.ts";
import {
  editPresentationTool,
  inspectPresentationTool,
  preparePresentationTools,
  renderPresentationTool,
  type PresentationToolResult,
} from "./tools.ts";

const fingerprint = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const invoke = (handler: unknown, params: unknown) =>
  Effect.runPromise(
    (handler as (params: unknown) => Effect.Effect<PresentationToolResult>)(params),
  );
const workerUrl = new URL("./runtime-worker.ts", import.meta.url);

describe("presentation tool parameters the model is offered", () => {
  const properties = (tool: Tool.Any) =>
    (Tool.getJsonSchema(tool) as { properties: Record<string, unknown> }).properties;

  it("offers each tool only its own fields, with integers that cannot be NaN", () => {
    expect(Object.keys(properties(inspectPresentationTool)).toSorted()).toEqual(
      [
        "page",
        "layoutOffset",
        "selectedSlideIds",
        "shapeOffset",
        "sourceRef",
        "templateId",
        "workingRef",
      ].toSorted(),
    );
    expect(Object.keys(properties(renderPresentationTool)).toSorted()).toEqual(
      ["slideIds", "sourceFingerprint", "sourceRef", "workingRef"].toSorted(),
    );
    const edit = properties(editPresentationTool);
    expect(Object.keys(edit)).not.toContain("page");
    const advertised = JSON.stringify(
      [inspectPresentationTool, editPresentationTool, renderPresentationTool].map(properties),
    );
    expect(advertised).not.toContain("NaN");
    expect(properties(renderPresentationTool).slideIds).toMatchObject({
      type: "array",
      items: { type: "integer" },
      maxItems: 4,
    });
  });

  it("describes every operation kind with its own required fields", () => {
    const branches = (
      properties(editPresentationTool).operations as {
        items: {
          anyOf: Array<{
            properties: { kind: { enum: string[] } };
            required: string[];
            additionalProperties: boolean;
          }>;
        };
      }
    ).items.anyOf;
    const setText = branches.find((branch) => branch.properties.kind.enum[0] === "setText")!;
    expect(setText.properties).toHaveProperty("placeholder");
    expect(setText.additionalProperties).toBe(false);
    const chart = branches.find((branch) => branch.properties.kind.enum[0] === "addChart")!;
    expect(chart.required).toEqual(
      expect.arrayContaining(["kind", "categories", "series", "chartType"]),
    );
    expect(branches.length).toBeGreaterThan(20);
  });
});

describe("presentation tool group", () => {
  it("creates and edits private drafts, checks revisions and hides pixels from results", async () => {
    const runtime = createPresentationRuntime(workerUrl);
    const workingFiles = createWorkingFiles();
    const previews: Uint8Array[] = [];
    const { group } = preparePresentationTools({
      runtime,
      workingFiles,
      resolveFile: () => Effect.fail("Not available"),
      onPreview: async (slides) => {
        previews.push(...slides.map((slide) => slide.png));
      },
    });
    try {
      const missingSource = await invoke(group.handlers.inspect_presentation, {});
      expect(missingSource.message).toBe(
        "invalid_operation: Provide exactly one of sourceRef or workingRef.",
      );
      const created = await invoke(group.handlers.edit_presentation, {
        create: true,
        operations: [],
      });
      expect(created.outcome).toBe("working");
      expect(created.slideCount).toBe(1);
      const workingRef = `working:${created.workingFileId}@${created.revision}`;
      const inspected = await invoke(group.handlers.inspect_presentation, {
        workingRef,
        selectedSlideIds: [(created.slides![0] as { slideId: number }).slideId],
      });
      expect(inspected.outcome).toBe("complete");
      expect((inspected.slides![0] as { shapes?: unknown[] }).shapes).toBeDefined();
      const slideId = (created.slides![0] as { slideId: number }).slideId;
      const edited = await invoke(group.handlers.edit_presentation, {
        workingRef,
        operations: [
          {
            kind: "addText",
            slideId,
            text: "Presentation tools",
            x: 20,
            y: 20,
            width: 200,
            height: 50,
          },
        ],
        renderSlideIds: [slideId],
      });
      expect(edited.revision).toBe(2);
      expect(previews[0]?.subarray(0, 8)).toEqual(
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      expect(JSON.stringify(edited)).not.toContain("png");
      expect((await invoke(group.handlers.inspect_presentation, { workingRef })).outcome).toBe(
        "error",
      );
      expect(
        (
          await invoke(group.handlers.render_presentation, {
            workingRef: `working:${created.workingFileId}@2`,
            slideIds: [slideId],
          })
        ).outcome,
      ).toBe("complete");
    } finally {
      workingFiles.dispose();
      await runtime.close();
    }
  });

  it("reads several selected slides in one call, whatever page they are on", async () => {
    const runtime = createPresentationRuntime(workerUrl);
    const workingFiles = createWorkingFiles();
    const { group } = preparePresentationTools({
      runtime,
      workingFiles,
      resolveFile: () => Effect.fail("Not available"),
    });
    try {
      const created = await invoke(group.handlers.edit_presentation, {
        create: true,
        operations: Array.from({ length: 11 }, () => ({ kind: "addSlide", layoutId: "Blank" })),
      });
      expect(created.slideCount).toBe(12);
      const ids = (created.slides as Array<{ slideId: number }>).map((slide) => slide.slideId);
      const overview = await invoke(group.handlers.inspect_presentation, {
        workingRef: created.workingRef,
      });
      expect(overview).toMatchObject({ slideIds: ids, nextPage: 1 });
      expect(overview.slides).toHaveLength(10);
      const inspected = await invoke(group.handlers.inspect_presentation, {
        workingRef: `working:${created.workingFileId}@${created.revision}`,
        selectedSlideIds: [ids[11], ids[0]],
      });
      const slides = inspected.slides as Array<{ slideId: number; shapes?: unknown[] }>;
      expect(slides.map((slide) => slide.slideId)).toEqual([ids[11], ids[0]]);
      for (const key of ["layouts", "masters", "theme", "availableFonts"])
        expect(inspected).not.toHaveProperty(key);
      expect(slides.filter((slide) => slide.shapes).map((slide) => slide.slideId)).toEqual([
        ids[11],
        ids[0],
      ]);
      expect(inspected.read).toEqual({ from: 1, to: 10, slides: [12, 1] });
      expect(
        (
          await invoke(group.handlers.inspect_presentation, {
            workingRef: `working:${created.workingFileId}@${created.revision}`,
            selectedSlideIds: ids.slice(0, 2),
            shapeOffset: 25,
          })
        ).message,
      ).toMatch(/shapeOffset: select exactly one slide/);
    } finally {
      workingFiles.dispose();
      await runtime.close();
    }
  });

  it("bounds actual slide handles and pages focused reads without repeating overview data", async () => {
    const runtime = createPresentationRuntime(workerUrl);
    const workingFiles = createWorkingFiles();
    const { group } = preparePresentationTools({
      runtime,
      workingFiles,
      resolveFile: () => Effect.fail("Not available"),
    });
    try {
      const created = await invoke(group.handlers.edit_presentation, {
        create: true,
        operations: Array.from({ length: 28 }, (_, index) => ({
          kind: "addText",
          slideRef: "first",
          text: `Text ${index}`,
          x: 10,
          y: 10,
          width: 200,
          height: 30,
        })),
      });
      const slide = created.slides![0] as {
        slideId: number;
        textTargets: { shapeId: number }[];
        textTargetsOmitted: number;
      };
      expect(slide.textTargets).toHaveLength(12);
      expect(slide.textTargetsOmitted).toBe(18);
      const workingRef = created.workingRef;
      const first = await invoke(group.handlers.inspect_presentation, {
        workingRef,
        selectedSlideIds: [slide.slideId],
      });
      expect(first).toMatchObject({ nextShapeOffset: 25, nextPage: null });
      expect(first).not.toHaveProperty("limits");
      const shapes = (first.slides![0] as { shapes: { shapeId: number }[] }).shapes;
      expect(shapes).toHaveLength(25);
      expect(
        slide.textTargets.every((target) =>
          shapes.some((shape) => shape.shapeId === target.shapeId),
        ),
      ).toBe(true);
      const rest = await invoke(group.handlers.inspect_presentation, {
        workingRef,
        selectedSlideIds: [slide.slideId],
        shapeOffset: 25,
      });
      expect(rest).toMatchObject({ nextShapeOffset: null });
      expect((rest.slides![0] as { shapes: unknown[] }).shapes).toHaveLength(5);
      const template = await invoke(group.handlers.inspect_presentation, {
        workingRef,
        templateId: "/ppt/slideLayouts/slideLayout1.xml",
      });
      expect(template).toMatchObject({
        slides: [],
        template: { kind: "layout", shapes: expect.any(Array) },
      });
      for (const result of [first, rest, template]) {
        for (const key of ["layouts", "masters", "theme", "availableFonts"])
          expect(result).not.toHaveProperty(key);
      }
    } finally {
      workingFiles.dispose();
      await runtime.close();
    }
  });

  it("qualifies new and existing audit measurements without automatic shrink advice", async () => {
    const runtime = createPresentationRuntime(workerUrl);
    const workingFiles = createWorkingFiles();
    const { group } = preparePresentationTools({
      runtime,
      workingFiles,
      resolveFile: () => Effect.fail("Not available"),
    });
    try {
      const created = await invoke(group.handlers.edit_presentation, {
        create: true,
        operations: [
          {
            kind: "addText",
            slideRef: "first",
            x: 40,
            y: 40,
            width: 200,
            height: 20,
            text: "One\nTwo\nThree\nFour\nFive",
          },
        ],
      });
      expect(created.overflow?.[0]?.classification).toBe("new");
      expect(created.message).toContain("1 new, increased or uncompared box overrun finding");
      const existing = await invoke(group.handlers.edit_presentation, {
        workingRef: created.workingRef,
        operations: [
          {
            kind: "addText",
            slideRef: "first",
            x: 600,
            y: 400,
            width: 200,
            height: 40,
            text: "ok",
          },
        ],
      });
      expect(existing.overflow?.[0]?.classification).toBe("existing");
      // Findings seen before need no action, so the message stays plain.
      expect(existing.message).toBe(
        "Private draft updated. Nothing is delivered until publish_file.",
      );
      for (const result of [created, existing])
        expect(result).toHaveProperty("overflowSummary.total", 1);
      const quiet = await invoke(group.handlers.edit_presentation, {
        workingRef: existing.workingRef,
        operations: [{ kind: "setNotes", slideRef: "first", text: "Review" }],
      });
      expect(quiet).not.toHaveProperty("overflow");
      expect(quiet).not.toHaveProperty("overflowSummary");
      // The advice on reading findings is stated once, in the tool description.
      const description = Tool.getDescription(editPresentationTool) ?? "";
      expect(description).toContain("not confirmed clipping");
      expect(description).toContain(
        "existing measurements alone do not justify another corrective edit",
      );
      expect(description).toContain("not a native PowerPoint fit guarantee");
      expect(description).not.toMatch(/Shorten it|reduce fontSize/);
    } finally {
      workingFiles.dispose();
      await runtime.close();
    }
  });

  it("returns bounded associated-template handles for the read or edit scope", async () => {
    const initial = await editPresentation(await createPresentationDraft(), [
      { kind: "addSlide", layoutId: "Title Slide" },
      { kind: "addSlide", layoutId: "Blank" },
      {
        kind: "addText",
        slideRef: "first",
        x: 10,
        y: 10,
        width: 200,
        height: 20,
        text: "Brand ".repeat(30),
      },
    ]);
    const parts = readPresentationArchive(initial.bytes);
    const decoder = new TextDecoder();
    const shape = decoder
      .decode(parts.get("ppt/slides/slide1.xml"))
      .match(/<p:sp>[\s\S]*?<\/p:sp>/g)!
      .at(-1)!;
    const title = initial.inspection.slides[0]!;
    for (const owner of [title.layoutId!, title.masterId!]) {
      const part = owner.slice(1);
      parts.set(
        part,
        strToU8(
          decoder
            .decode(parts.get(part))
            .replace(
              "</p:spTree>",
              Array.from({ length: 15 }, (_, index) =>
                shape
                  .replace(/(<p:cNvPr\b[^>]*id=")\d+/, `$1${90 + index}`)
                  .replace(/(<p:cNvPr\b[^>]*name=")[^"]*/, `$1${"Brand".repeat(40)}`),
              ).join("") + "</p:spTree>",
            ),
        ),
      );
    }
    const bytes = zipSync(Object.fromEntries(parts));
    const sourceRef = "attachment:2da5d185-e869-4d2a-8a20-3efffa46c40b";
    const runtime = createPresentationRuntime(workerUrl);
    const workingFiles = createWorkingFiles();
    const { group } = preparePresentationTools({
      runtime,
      workingFiles,
      resolveFile: () =>
        Effect.succeed({
          bytes,
          name: "Template.pptx",
          mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          source: { kind: "chat" as const, attachmentId: sourceRef.slice(11) },
          ref: { kind: "attachment" as const, id: sourceRef.slice(11) },
        }),
    });
    try {
      const overview = await invoke(group.handlers.inspect_presentation, { sourceRef });
      expect(overview.outcome, overview.message).toBe("complete");
      expect(overview.templateTargets).toMatchObject({
        ownerCount: 3,
        ownersOmitted: 0,
        targetCount: 30,
        omitted: 6,
      });
      const targets = overview.templateTargets!.owners.flatMap((owner) => owner.targets);
      expect(targets).toHaveLength(24);
      expect(
        targets.every((target) => target.name.length <= 100 && target.text.length <= 100),
      ).toBe(true);
      expect(
        overview.templateTargets!.owners.find((owner) => owner.templateId === title.masterId)!
          .affectedSlideCount,
      ).toBe(3);
      expect(
        overview.templateTargets!.owners.find((owner) => owner.templateId === title.layoutId)!
          .affectedSlideCount,
      ).toBe(2);
      const blank = initial.inspection.slides[2]!;
      const focused = await invoke(group.handlers.inspect_presentation, {
        sourceRef,
        selectedSlideIds: [blank.slideId],
      });
      expect(focused.templateTargets).toMatchObject({ ownerCount: 2, targetCount: 15, omitted: 0 });
      expect(
        focused.templateTargets!.owners.some((owner) => owner.templateId === title.layoutId),
      ).toBe(false);
      const exact = targets[0]!;
      const edited = await invoke(group.handlers.edit_presentation, {
        sourceRef,
        sourceFingerprint: overview.fingerprint,
        operations: [{ kind: "removeShape", templateId: exact.templateId, shapeId: exact.shapeId }],
      });
      expect(edited.outcome).toBe("working");
      expect(edited.templateTargets).toMatchObject({ targetCount: 29, omitted: 5 });
      expect(
        edited
          .templateTargets!.owners.find((owner) => owner.templateId === exact.templateId)!
          .targets.some((target) => target.shapeId === exact.shapeId),
      ).toBe(false);
      const full = await invoke(group.handlers.inspect_presentation, {
        workingRef: edited.workingRef,
        templateId: title.masterId,
      });
      expect(full).toHaveProperty("template.shapes");
      expect(full).not.toHaveProperty("templateTargets");
    } finally {
      workingFiles.dispose();
      await runtime.close();
    }
  });

  it("caps owners and scopes overview candidates to the returned slide page", async () => {
    const initial = await editPresentation(
      await createPresentationDraft(),
      Array.from({ length: 12 }, () => ({ kind: "addSlide", layoutId: "Title Slide" })),
    );
    const parts = readPresentationArchive(initial.bytes);
    const decoder = new TextDecoder();
    const layout = decoder.decode(parts.get("ppt/slideLayouts/slideLayout1.xml"));
    const layoutRels = parts.get("ppt/slideLayouts/_rels/slideLayout1.xml.rels")!;
    for (let index = 1; index <= 13; index++) {
      const name = `slideLayout${20 + index}.xml`;
      parts.set(`ppt/slideLayouts/${name}`, strToU8(layout));
      parts.set(`ppt/slideLayouts/_rels/${name}.rels`, layoutRels);
      const rel = `ppt/slides/_rels/slide${index}.xml.rels`;
      parts.set(rel, strToU8(decoder.decode(parts.get(rel)).replace(/slideLayout\d+\.xml/, name)));
    }
    parts.set(
      "[Content_Types].xml",
      strToU8(
        decoder
          .decode(parts.get("[Content_Types].xml"))
          .replace(
            "</Types>",
            Array.from(
              { length: 13 },
              (_, index) =>
                `<Override PartName="/ppt/slideLayouts/slideLayout${21 + index}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`,
            ).join("") + "</Types>",
          ),
      ),
    );
    parts.set(
      "ppt/slideMasters/slideMaster1.xml",
      strToU8(
        decoder
          .decode(parts.get("ppt/slideMasters/slideMaster1.xml"))
          .replace(
            "</p:sldLayoutIdLst>",
            Array.from(
              { length: 13 },
              (_, index) => `<p:sldLayoutId id="${3000000000 + index}" r:id="rIdExtra${index}"/>`,
            ).join("") + "</p:sldLayoutIdLst>",
          ),
      ),
    );
    parts.set(
      "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      strToU8(
        decoder
          .decode(parts.get("ppt/slideMasters/_rels/slideMaster1.xml.rels"))
          .replace(
            "</Relationships>",
            Array.from(
              { length: 13 },
              (_, index) =>
                `<Relationship Id="rIdExtra${index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout${21 + index}.xml"/>`,
            ).join("") + "</Relationships>",
          ),
      ),
    );
    const bytes = zipSync(Object.fromEntries(parts));
    const id = "2da5d185-e869-4d2a-8a20-3efffa46c40b";
    const runtime = createPresentationRuntime(workerUrl);
    const workingFiles = createWorkingFiles();
    const { group } = preparePresentationTools({
      runtime,
      workingFiles,
      resolveFile: () =>
        Effect.succeed({
          bytes,
          name: "Layouts.pptx",
          mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          source: { kind: "chat" as const, attachmentId: id },
          ref: { kind: "attachment" as const, id },
        }),
    });
    try {
      const first = await invoke(group.handlers.inspect_presentation, {
        sourceRef: `attachment:${id}`,
      });
      expect(first.outcome, first.message).toBe("complete");
      expect(first.templateTargets).toMatchObject({ ownerCount: 11, ownersOmitted: 0 });
      const second = await invoke(group.handlers.inspect_presentation, {
        sourceRef: `attachment:${id}`,
        page: 1,
      });
      expect(second.templateTargets).toMatchObject({ ownerCount: 4, ownersOmitted: 0 });
      const edited = await invoke(group.handlers.edit_presentation, {
        sourceRef: `attachment:${id}`,
        sourceFingerprint: first.fingerprint,
        operations: [
          {
            kind: "setBackground",
            templateId: "/ppt/slideMasters/slideMaster1.xml",
            color: "#FFFFFF",
          },
        ],
      });
      expect(edited.outcome, edited.message).toBe("working");
      expect(edited.templateTargets).toMatchObject({ ownerCount: 14, ownersOmitted: 2 });
      expect(edited.templateTargets!.owners).toHaveLength(12);
      expect(
        edited.templateTargets!.owners.find((owner) => owner.templateId.includes("slideMaster"))!
          .affectedSlideCount,
      ).toBe(13);
    } finally {
      workingFiles.dispose();
      await runtime.close();
    }
  });

  it("resolves an authorized image without requiring an undiscoverable fingerprint", async () => {
    const runtime = createPresentationRuntime(workerUrl);
    const workingFiles = createWorkingFiles();
    const imageRef = "attachment:2da5d185-e869-4d2a-8a20-3efffa46c40b";
    const image = new Uint8Array(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uAAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const { group } = preparePresentationTools({
      runtime,
      workingFiles,
      resolveFile: (ref) =>
        ref === imageRef
          ? Effect.succeed({
              bytes: image,
              name: "Graphic.png",
              mediaType: "image/png",
              source: {
                kind: "chat" as const,
                attachmentId: "2da5d185-e869-4d2a-8a20-3efffa46c40b",
              },
              ref: { kind: "attachment" as const, id: "2da5d185-e869-4d2a-8a20-3efffa46c40b" },
            })
          : Effect.fail("Not available"),
    });
    try {
      const initial = await invoke(group.handlers.edit_presentation, {
        create: true,
        operations: [],
      });
      const slideId = (initial.slides![0] as { slideId: number }).slideId;
      const workingRef = `working:${initial.workingFileId}@${initial.revision}`;
      const changed = await invoke(group.handlers.edit_presentation, {
        workingRef,
        operations: [{ kind: "addImage", slideId, imageRef, x: 20, y: 20, width: 50, height: 50 }],
      });
      expect(changed.outcome).toBe("working");
      expect(changed.revision).toBe(2);
      const mismatch = await invoke(group.handlers.edit_presentation, {
        workingRef: `working:${initial.workingFileId}@2`,
        operations: [
          {
            kind: "addImage",
            slideId,
            imageRef,
            imageFingerprint: "0".repeat(64),
            x: 20,
            y: 20,
            width: 50,
            height: 50,
          },
        ],
      });
      expect(mismatch.outcome).toBe("error");
      expect(workingFiles.unfinished()[0]?.ref.revision).toBe(2);
    } finally {
      workingFiles.dispose();
      await runtime.close();
    }
  });

  it("rejects forged file refs, changed source fingerprints and inline image bytes", async () => {
    const runtime = createPresentationRuntime(workerUrl);
    const workingFiles = createWorkingFiles();
    const initial = await runtime.run({ kind: "create" });
    const sourceRef = "attachment:22e51456-8901-4cb2-96ed-44d69e845c30";
    const { group } = preparePresentationTools({
      runtime,
      workingFiles,
      resolveFile: (ref) =>
        ref === sourceRef
          ? Effect.succeed({
              bytes: initial,
              name: "Deck.pptx",
              mediaType:
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
              source: {
                kind: "chat" as const,
                attachmentId: "22e51456-8901-4cb2-96ed-44d69e845c30",
              },
              ref: { kind: "attachment" as const, id: "22e51456-8901-4cb2-96ed-44d69e845c30" },
            })
          : Effect.fail("No access"),
    });
    try {
      const valid = await invoke(group.handlers.inspect_presentation, { sourceRef });
      expect(valid.outcome).toBe("complete");
      // What it covered, by position, so the activity row can say so.
      expect(valid.read).toEqual({ from: 1, to: valid.slideCount });
      expect(valid.fingerprint).toBe(fingerprint(initial));
      expect(valid.sourceRef).toBe(sourceRef);
      expect(
        (await invoke(group.handlers.edit_presentation, { sourceRef, operations: [] })).outcome,
      ).toBe("error");
      expect(
        (
          await invoke(group.handlers.inspect_presentation, {
            sourceRef,
            sourceFingerprint: "0".repeat(64),
          })
        ).outcome,
      ).toBe("error");
      expect(
        (
          await invoke(group.handlers.inspect_presentation, {
            sourceRef: "attachment:other",
            sourceFingerprint: fingerprint(initial),
          })
        ).outcome,
      ).toBe("error");
      expect(
        (
          await invoke(group.handlers.edit_presentation, {
            sourceRef,
            sourceFingerprint: fingerprint(initial),
            operations: [{ kind: "addImage", slideId: 256, image: [1, 2, 3] }],
          })
        ).outcome,
      ).toBe("error");
      expect(workingFiles.unfinished()).toHaveLength(0);
      const draft = await invoke(group.handlers.edit_presentation, {
        sourceRef,
        sourceFingerprint: fingerprint(initial),
        operations: [],
      });
      expect(draft.outcome).toBe("working");
      const ref = workingFiles.unfinished()[0]!.ref;
      const pending = workingFiles.preparePublish(ref);
      expect(pending.state).toBe("pending");
      if (pending.state !== "pending") throw new Error("Expected a working draft.");
      expect(pending.file.source).toBe(sourceRef);
      workingFiles.finishPublish(ref);
    } finally {
      workingFiles.dispose();
      await runtime.close();
    }
  });

  it("accepts near-miss arguments, names bad fields and summarizes changes", async () => {
    const runtime = createPresentationRuntime(workerUrl);
    const workingFiles = createWorkingFiles();
    const rendered: number[][] = [];
    const { group } = preparePresentationTools({
      runtime,
      workingFiles,
      resolveFile: () => Effect.fail("Not available"),
      onPreview: async (slides) => {
        rendered.push(slides.map((slide) => slide.slideId));
      },
    });
    try {
      const created = await invoke(group.handlers.edit_presentation, {
        create: true,
        fileName: "Deck.pptx",
        page: null,
        operations: [
          { kind: "setText", slideId: "256", slideRef: null, placeholder: "title", text: "x" },
        ],
      });
      expect(created).toMatchObject({
        outcome: "working",
        origin: "created",
        changes: "Wrote the text",
      });
      expect(created.workingRef).toBe(`working:${created.workingFileId}@1`);
      const slideId = (created.slides![0] as { slideId: number }).slideId;
      const render = await invoke(group.handlers.render_presentation, {
        workingRef: created.workingRef,
        slideIds: String(slideId),
      });
      expect(render).toMatchObject({ outcome: "complete", renderedSlideIds: [slideId] });
      expect(rendered).toEqual([[slideId]]);
      const bad = await invoke(group.handlers.edit_presentation, {
        workingRef: created.workingRef,
        operations: [
          { kind: "addSlide", layoutId: "Title and Content", ref: "next" },
          {
            kind: "addText",
            slideRef: "next",
            x: 1,
            y: 1,
            width: 10,
            height: 10,
            text: "y",
            bullets: true,
          },
        ],
      });
      expect(bad.outcome).toBe("error");
      expect(bad.message).toContain('operations[1] addText: unknown field "bullets"');
      const batch = await invoke(group.handlers.edit_presentation, {
        workingRef: created.workingRef,
        operations: JSON.stringify([
          { kind: "addSlide", layoutId: "Title and Content", ref: "next" },
          {
            kind: "setText",
            slideRef: "next",
            placeholder: "body",
            paragraphs: [{ text: "a" }, { text: "b", level: 1 }],
          },
        ]),
      });
      expect(batch).toMatchObject({
        outcome: "working",
        revision: 2,
        changes: "Added a slide and wrote the text",
      });
      expect(batch.origin).toBeUndefined();
      expect(Object.keys(batch.refs!.slides)).toEqual(["next"]);
    } finally {
      workingFiles.dispose();
      await runtime.close();
    }
  });

  it("offers only fonts previews can draw and normalizes their spelling", async () => {
    const runtime = createPresentationRuntime(workerUrl);
    const workingFiles = createWorkingFiles();
    const { group } = preparePresentationTools({
      runtime,
      workingFiles,
      resolveFile: () => Effect.fail("Not available"),
      fonts: async () => ["Calibri", "Brand Sans"],
    });
    try {
      const created = await invoke(group.handlers.edit_presentation, {
        create: true,
        operations: [
          { kind: "setText", slideId: 256, placeholder: "title", text: "x", font: "brand sans" },
        ],
      });
      expect(created).toMatchObject({
        outcome: "working",
        availableFonts: ["Calibri", "Brand Sans"],
      });
      const unknown = await invoke(group.handlers.edit_presentation, {
        workingRef: created.workingRef,
        operations: [{ kind: "setTheme", headingFont: "Comic Sans MS" }],
      });
      expect(unknown.outcome).toBe("error");
      expect(unknown.message).toContain(
        'headingFont: "Comic Sans MS" isn\'t available; use one of Calibri, Brand Sans',
      );
    } finally {
      workingFiles.dispose();
      await runtime.close();
    }
  });

  it("reads a draft passed as sourceRef as meant, and renders the first slides of too many", async () => {
    const runtime = createPresentationRuntime(workerUrl);
    const workingFiles = createWorkingFiles();
    const previewed: number[][] = [];
    const { group } = preparePresentationTools({
      runtime,
      workingFiles,
      resolveFile: () => Effect.fail("Not available"),
      onPreview: async (slides) => {
        previewed.push(slides.map((slide) => slide.slideId));
      },
    });
    try {
      const created = await invoke(group.handlers.edit_presentation, {
        create: true,
        operations: Array.from({ length: 4 }, () => ({ kind: "addSlide", layoutId: "Blank" })),
      });
      const ids = (created.slides as Array<{ slideId: number }>).map((slide) => slide.slideId);
      expect(ids).toHaveLength(5);
      // Its own draft in the source field: inspected as the draft, no fingerprint asked for.
      const inspected = await invoke(group.handlers.inspect_presentation, {
        sourceRef: created.workingRef,
      });
      expect(inspected).toMatchObject({ slideIds: ids, workingFileId: created.workingFileId });
      const rendered = await invoke(group.handlers.render_presentation, {
        sourceRef: created.workingRef,
        slideIds: ids,
      });
      expect(rendered).toMatchObject({ outcome: "complete", renderedSlideIds: ids.slice(0, 4) });
      expect(rendered.message).toContain(`render ${ids[4]} in another call`);
      expect(previewed).toEqual([ids.slice(0, 4)]);
    } finally {
      workingFiles.dispose();
      await runtime.close();
    }
  });

  it("fetches a curated family an edit names before checking it, chart text included", async () => {
    const runtime = createPresentationRuntime(workerUrl);
    const workingFiles = createWorkingFiles();
    const installed = ["Calibri"];
    const asked: string[][] = [];
    const { group } = preparePresentationTools({
      runtime,
      workingFiles,
      resolveFile: () => Effect.fail("Not available"),
      fonts: async () => [...installed],
      // Abril Fatface arrives; Poppins stays unreachable, as when offline.
      ensureFonts: async (families) => {
        asked.push([...families]);
        if (families.some((family) => family.toLowerCase() === "abril fatface"))
          installed.push("Abril Fatface");
      },
    });
    try {
      const created = await invoke(group.handlers.edit_presentation, {
        create: true,
        operations: [{ kind: "setTheme", headingFont: "abril fatface", bodyFont: "Calibri" }],
      });
      expect(created).toMatchObject({ outcome: "working" });
      expect(asked).toEqual([["abril fatface", "Calibri"]]);
      const offline = await invoke(group.handlers.edit_presentation, {
        workingRef: created.workingRef,
        operations: [{ kind: "setTheme", bodyFont: "Poppins" }],
      });
      expect(offline.outcome).toBe("error");
      expect(offline.message).toContain('"Poppins" couldn\'t be loaded right now');
      // Nothing new named: the installed list is enough, no fetch is asked for.
      await invoke(group.handlers.edit_presentation, {
        workingRef: created.workingRef,
        operations: [{ kind: "setTheme", headingFont: "Abril Fatface" }],
      });
      expect(asked).toHaveLength(2);
    } finally {
      workingFiles.dispose();
      await runtime.close();
    }
  });

  it("fills a new deck's first slide by ref and previews what the edit changed", async () => {
    const runtime = createPresentationRuntime(workerUrl);
    const workingFiles = createWorkingFiles();
    const previewed: number[][] = [];
    const { group } = preparePresentationTools({
      runtime,
      workingFiles,
      resolveFile: () => Effect.fail("Not available"),
      onPreview: async (slides) => {
        previewed.push(slides.map((slide) => slide.slideId));
      },
    });
    try {
      const created = await invoke(group.handlers.edit_presentation, {
        create: true,
        operations: [
          { kind: "setText", slideRef: "first", placeholder: "title", text: "Hello" },
          { kind: "addSlide", layoutId: "Title and Content", ref: "next" },
          { kind: "setText", slideRef: "next", placeholder: "title", text: "Agenda" },
        ],
        render: "changed",
      });
      expect(created).toMatchObject({ outcome: "working", slideCount: 2 });
      const ids = (created.slides as { slideId: number }[]).map((slide) => slide.slideId);
      expect(previewed).toEqual([ids]);
      const edited = await invoke(group.handlers.edit_presentation, {
        workingRef: created.workingRef,
        operations: [{ kind: "setText", slideId: ids[1], placeholder: "body", text: "Point" }],
        render: "changed",
      });
      expect(edited.renderedSlideIds).toEqual([ids[1]]);
      const both = await invoke(group.handlers.edit_presentation, {
        workingRef: edited.workingRef,
        operations: [],
        render: "all",
        renderSlideIds: [ids[0]],
      });
      expect(both.message).toContain("Use render or renderSlideIds, not both.");
    } finally {
      workingFiles.dispose();
      await runtime.close();
    }
  });

  it("opens a deck imported from the computer as a source and places an imported picture", async () => {
    const runtime = createPresentationRuntime(workerUrl);
    const workingFiles = createWorkingFiles();
    const created = await runtime.run({ kind: "create" });
    const deck = workingFiles.create({
      bytes: created,
      name: "Local.pptx",
      mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      owner: "local",
    });
    const picture = workingFiles.create({
      bytes: new Uint8Array(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uAAAAABJRU5ErkJggg==",
          "base64",
        ),
      ),
      name: "logo.png",
      mediaType: "image/png",
      owner: "local",
    });
    const deckRef = `working:${deck.ref.id}@1`;
    const pictureRef = `working:${picture.ref.id}@1`;
    const { group } = preparePresentationTools({
      runtime,
      workingFiles,
      resolveFile: (reference) =>
        Effect.try({
          try: () => {
            const ref = reference === pictureRef ? picture.ref : deck.ref;
            const file = workingFiles.read(ref);
            return {
              name: file.name,
              mediaType: file.mediaType,
              bytes: file.bytes,
              source: { kind: "working" as const, workingFileId: ref.id, revision: ref.revision },
              ref,
            };
          },
          catch: () => "Not available",
        }),
    });
    try {
      expect(
        (await invoke(group.handlers.inspect_presentation, { sourceRef: deckRef })).outcome,
      ).toBe("complete");
      const opened = await invoke(group.handlers.edit_presentation, {
        sourceRef: deckRef,
        operations: [
          {
            kind: "addImage",
            slideRef: "first",
            imageRef: pictureRef,
            x: 20,
            y: 20,
            width: 40,
            height: 40,
          },
        ],
      });
      // A new draft of its own; the import itself stays untouched for another use.
      expect(opened).toMatchObject({ outcome: "working", origin: "opened", revision: 1 });
      expect(opened.workingFileId).not.toBe(deck.ref.id);
      expect(workingFiles.read(deck.ref).bytes).toEqual(created);
      // Passed in the other field, the import is still read as the source it is.
      const swapped = await invoke(group.handlers.edit_presentation, {
        workingRef: deckRef,
        operations: [],
      });
      expect(swapped).toMatchObject({ outcome: "working", origin: "opened" });
      expect(swapped.workingFileId).not.toBe(deck.ref.id);
    } finally {
      workingFiles.dispose();
      await runtime.close();
    }
  });

  it("accepts a source the resolver maps to another attachment, as in a branched chat", async () => {
    const runtime = createPresentationRuntime(workerUrl);
    const workingFiles = createWorkingFiles();
    const created = await runtime.run({ kind: "create" });
    const [asked, current] = [
      "2da5d185-e869-4d2a-8a20-3efffa46c40b",
      "22e51456-8901-4cb2-96ed-44d69e845c30",
    ];
    const { group } = preparePresentationTools({
      runtime,
      workingFiles,
      resolveFile: () =>
        Effect.succeed({
          bytes: created,
          name: "Branched.pptx",
          mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          source: { kind: "chat" as const, attachmentId: current },
          ref: { kind: "attachment" as const, id: current },
        }),
    });
    try {
      const inspected = await invoke(group.handlers.inspect_presentation, {
        sourceRef: `attachment:${asked}`,
      });
      expect(inspected.outcome, inspected.message).toBe("complete");
      expect(inspected.sourceRef).toBe(`attachment:${current}`);
      const edited = await invoke(group.handlers.edit_presentation, {
        sourceRef: `attachment:${asked}`,
        sourceFingerprint: inspected.fingerprint,
        operations: [],
      });
      expect(edited.outcome, edited.message).toBe("working");
      const draft = workingFiles.unfinished()[0]!;
      expect(workingFiles.read(draft.ref).source).toBe(`attachment:${current}`);
    } finally {
      workingFiles.dispose();
      await runtime.close();
    }
  });

  it("labels a page given as a decimal string and omits unset master flags", async () => {
    const runtime = createPresentationRuntime(workerUrl);
    const workingFiles = createWorkingFiles();
    const { group } = preparePresentationTools({
      runtime,
      workingFiles,
      resolveFile: () => Effect.fail("Not available"),
    });
    try {
      const created = await invoke(group.handlers.edit_presentation, {
        create: true,
        operations: Array.from({ length: 11 }, () => ({ kind: "addSlide", layoutId: "Blank" })),
      });
      const second = await invoke(group.handlers.inspect_presentation, {
        workingRef: created.workingRef,
        page: "1",
      });
      expect(second.read).toEqual({ from: 11, to: 12 });
      expect(second.slides).toHaveLength(2);
      for (const slide of second.slides ?? []) {
        expect(slide).not.toHaveProperty("showMasterSp");
        expect(slide).not.toHaveProperty("layoutShowMasterSp");
      }
    } finally {
      workingFiles.dispose();
      await runtime.close();
    }
  });

  it("refuses a bad file name before any presentation work runs", async () => {
    const runtime = createPresentationRuntime(workerUrl);
    const workingFiles = createWorkingFiles();
    const kinds: string[] = [];
    const { group } = preparePresentationTools({
      runtime: {
        ...runtime,
        run: (request, signal, options) => {
          kinds.push(request.kind);
          return runtime.run(request, signal, options);
        },
      },
      workingFiles,
      resolveFile: () => Effect.fail("Not available"),
    });
    try {
      const result = await invoke(group.handlers.edit_presentation, {
        create: true,
        fileName: "Deck.docx",
        operations: [],
      });
      expect(result.message).toContain("fileName: expected a name ending in .pptx");
      expect(kinds).toEqual([]);
      expect(workingFiles.unfinished()).toHaveLength(0);
    } finally {
      workingFiles.dispose();
      await runtime.close();
    }
  });

  it("refuses a source that isn't a deck before any worker opens it", async () => {
    const sourceRef = "attachment:2da5d185-e869-4d2a-8a20-3efffa46c40c";
    const runtime = createPresentationRuntime(workerUrl);
    const workingFiles = createWorkingFiles();
    const { group } = preparePresentationTools({
      runtime,
      workingFiles,
      resolveFile: () =>
        Effect.succeed({
          bytes: new Uint8Array([1, 2, 3]),
          name: "Budget.xlsx",
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          source: { kind: "chat" as const, attachmentId: sourceRef.slice(11) },
          ref: { kind: "attachment" as const, id: sourceRef.slice(11) },
        }),
    });
    try {
      const refused = await invoke(group.handlers.inspect_presentation, { sourceRef });
      expect(refused).toMatchObject({
        outcome: "error",
        message: "invalid_operation: Budget.xlsx is not a .pptx presentation.",
      });
    } finally {
      workingFiles.dispose();
      await runtime.close();
    }
  });
});
