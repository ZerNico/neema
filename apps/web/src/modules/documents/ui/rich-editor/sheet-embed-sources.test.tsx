import type { Editor } from "@tiptap/core";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SheetEmbedSources } from "./sheet-embed-sources.tsx";
import { sheetEmbedHub } from "./sheet-embeds.ts";

// The live source's chunk failing to load, as after a deploy replaced it.
vi.mock("./sheet-embed-live.tsx", () => {
  throw new Error("chunk gone");
});

describe("an editor's sheet sources", () => {
  it("show every embed as unavailable when their source cannot load, keeping the page", async () => {
    const editor = {} as Editor;
    const hub = sheetEmbedHub(editor);
    hub.acquire("sheet-1");
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SheetEmbedSources editor={editor} />);
    await waitFor(() => expect(hub.source("sheet-1").status).toBe("unavailable"));
  });
});
