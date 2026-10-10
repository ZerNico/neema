import { Toolbar } from "@base-ui/react/toolbar";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConditionalRule } from "@chat/sheet/model/conditional";
import { ConditionalMenu } from "./conditional-menu.tsx";

afterEach(cleanup);

describe("the conditional formatting menu", () => {
  it("asks for a value and a style, and adds bars in one click", async () => {
    const added: ConditionalRule[] = [];
    render(
      <Toolbar.Root>
        <ConditionalMenu
          rules={[]}
          where={() => "A1:A3"}
          onAdd={(rule) => added.push(rule)}
          onClear={() => {}}
          onEdit={() => {}}
        />
      </Toolbar.Root>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Conditional formatting" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Highlight cells rules" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Greater than…" }));
    fireEvent.change(await screen.findByLabelText("Value"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    fireEvent.click(screen.getByRole("button", { name: "Conditional formatting" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Data bars" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Green" }));
    expect(added).toEqual([
      {
        kind: "compare",
        op: "greater",
        values: [100],
        style: { fill: "#FFC7CE", fontColor: "#9C0006" },
      },
      { kind: "bar", color: "#63BE7B" },
    ]);
  });
});
