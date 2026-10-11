import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ColorPicker } from "./color-picker.tsx";

describe("the colour picker", () => {
  it("commits a colour from the keys and from a typed hex code, one change each", () => {
    const picked: string[] = [];
    render(<ColorPicker value="#FF0000" onChange={(hex) => picked.push(hex)} />);
    // Shift+Left takes a tenth of the saturation off the red.
    fireEvent.keyDown(screen.getByRole("slider", { name: "Saturation and brightness" }), {
      key: "ArrowLeft",
      shiftKey: true,
    });
    const hex = screen.getByRole("textbox", { name: "Hex colour" });
    fireEvent.change(hex, { target: { value: "00ff00" } });
    expect(picked).toHaveLength(1);
    fireEvent.keyDown(hex, { key: "Enter" });
    // A code that is not one changes nothing.
    fireEvent.change(hex, { target: { value: "#12" } });
    fireEvent.blur(hex);
    expect(picked).toEqual(["#FF1919", "#00FF00"]);
  });
});
