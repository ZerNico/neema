import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { applyChange } from "@chat/sheet/model/apply";
import { emptyDoc } from "@chat/sheet/model";
import type { SheetOp } from "@chat/sheet/model/ops";
import { SheetTabs } from "./sheet-tabs.tsx";

afterEach(cleanup);

describe("the sheet tabs", () => {
  it("moves, colours, downloads and adds sheets from a tab's menu", async () => {
    const doc = applyChange(
      emptyDoc(),
      {
        clientId: "t",
        seq: 1,
        ops: [
          { op: "sheetAdd", id: "s2", name: "Data", after: "s1", rows: ["a"], cols: ["b"] },
          { op: "sheetColor", id: "s2", color: "#C00000" },
        ],
      },
      1,
    ).doc;
    const ran: SheetOp[] = [];
    const downloaded: string[] = [];
    render(
      <SheetTabs
        doc={doc}
        current="s1"
        readOnly={false}
        mint={() => "s3"}
        run={(ops) => ran.push(...ops)}
        onPick={() => {}}
        onDownload={(id) => downloaded.push(id)}
        onPrint={(id) => downloaded.push(`print ${id}`)}
      />,
    );
    const data = screen.getByRole("tab", { name: "Data" });
    // A coloured tab carries its colour as a bar under its name.
    expect(data.querySelector("span[aria-hidden]")?.getAttribute("style")).toContain(
      "background-color",
    );
    fireEvent.contextMenu(data);
    expect(
      (await screen.findByRole("menuitem", { name: "Move right" })).getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Move left" }));
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Data" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Download as CSV" }));
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Data" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Print" }));
    fireEvent.click(screen.getByRole("button", { name: "Add sheet" }));
    expect(ran).toEqual([
      { op: "sheetMove", id: "s2", after: null },
      expect.objectContaining({ op: "sheetAdd", id: "s3", name: "Sheet3", after: "s2" }),
    ]);
    expect(downloaded).toEqual(["s2", "print s2"]);
  });
});
