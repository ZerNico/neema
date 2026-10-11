import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LinkDialog } from "./link-dialog.tsx";
import { linkOf } from "./link.ts";

afterEach(cleanup);

describe("the link dialog", () => {
  it("reads an address as typed, adding its scheme, and refuses script", () => {
    expect(linkOf("example.com/a")).toBe("https://example.com/a");
    expect(linkOf("ana@example.com")).toBe("mailto:ana@example.com");
    expect(linkOf("http://localhost:3000")).toBe("http://localhost:3000/");
    expect(linkOf("javascript:alert(1)")).toBeNull();
    expect(linkOf("  ")).toBeNull();
  });

  it("sets a link and the text shown, and removes a link when the address is cleared", () => {
    const applied: Array<{ text: string | null; link: string | null }> = [];
    const { unmount } = render(
      <LinkDialog
        text="Docs"
        link={undefined}
        textEditable
        onApply={(change) => applied.push(change)}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "Handbook" } });
    fireEvent.change(screen.getByLabelText("Link"), { target: { value: "javascript:x" } });
    expect(screen.getByText("Use a web or mail address.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Link"), { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    unmount();
    render(
      <LinkDialog
        text="Handbook"
        link="https://example.com/"
        textEditable={false}
        onApply={(change) => applied.push(change)}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByLabelText("Text")).toBeNull();
    fireEvent.change(screen.getByLabelText("Link"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove link" }));
    expect(applied).toEqual([
      { text: "Handbook", link: "https://example.com/" },
      { text: null, link: null },
    ]);
  });
});
