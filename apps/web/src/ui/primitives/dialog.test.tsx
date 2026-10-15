import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./dialog.tsx";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "./alert-dialog.tsx";

describe("DialogContent", () => {
  it("scrolls inside the rounded popup and keeps the close button outside the scroller", () => {
    render(
      <Dialog open>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>
          <DialogFooter>Done</DialogFooter>
        </DialogContent>
      </Dialog>,
    );

    const popup = screen.getByRole("dialog", { name: "Settings" });
    const scrollArea = popup.querySelector('[data-slot="dialog-scroll-area"]');
    expect(popup).toHaveClass(
      "max-h-[calc(var(--dialog-viewport-height,100dvh)-2rem)]",
      "overflow-hidden",
      "sm:max-w-2xl",
    );
    expect(scrollArea).toHaveClass("overflow-y-auto", "p-6");
    expect(scrollArea).not.toHaveClass("m-3");
    expect(scrollArea).toContainElement(screen.getByText("Done"));
    expect(scrollArea).not.toContainElement(screen.getByRole("button", { name: "Close" }));
  });

  it("leaves dialogs with their own inner scroller alone", () => {
    render(
      <Dialog open>
        <DialogContent scrollable={false}>
          <DialogHeader>
            <DialogTitle>Access</DialogTitle>
          </DialogHeader>
          <div data-testid="access-list" className="overflow-y-auto" />
        </DialogContent>
      </Dialog>,
    );

    const popup = screen.getByRole("dialog", { name: "Access" });
    expect(popup).toHaveClass("p-6", "gap-6");
    expect(popup.querySelector('[data-slot="dialog-scroll-area"]')).toBeNull();
    expect(screen.getByTestId("access-list").parentElement).toBe(popup);
  });
});

describe("nested dialogs", () => {
  it("dims the dialog underneath, and a click beside the top one closes it rather than reaching through", async () => {
    function Stack() {
      const [opened, setOpened] = useState(0);
      return (
        <Dialog open>
          <DialogContent>
            <DialogTitle>Table</DialogTitle>
            <button type="button" onClick={() => setOpened((count) => count + 1)}>
              Open file
            </button>
            {Array.from({ length: opened }, (_, index) => (
              <Dialog key={index} defaultOpen>
                <DialogContent>
                  <DialogTitle>File {index + 1}</DialogTitle>
                </DialogContent>
              </Dialog>
            ))}
          </DialogContent>
        </Dialog>
      );
    }
    render(<Stack />);
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    await screen.findByRole("dialog", { name: "File 1" });
    const overlays = document.querySelectorAll('[data-slot="dialog-overlay"]');
    expect(overlays).toHaveLength(2);
    // The press lands on the top dialog's backdrop, which closes that dialog alone.
    fireEvent.pointerDown(overlays[1]!);
    fireEvent.mouseDown(overlays[1]!);
    fireEvent.click(overlays[1]!);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "File 1" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("dialog", { name: "Table" })).toBeInTheDocument();
  });
});

describe("AlertDialogContent", () => {
  it("keeps long confirmation text and actions within the phone viewport", () => {
    const name = "A".repeat(200);
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Delete “{name}”?</AlertDialogTitle>
          <AlertDialogDescription>{name} and its files will be deleted.</AlertDialogDescription>
          <button>Cancel</button>
        </AlertDialogContent>
      </AlertDialog>,
    );
    const popup = screen.getByRole("alertdialog");
    expect(popup).toHaveClass("w-[calc(100%-2rem)]", "overflow-y-auto");
    expect(screen.getByText(`Delete “${name}”?`)).toHaveClass("wrap-anywhere");
    expect(screen.getByText(`${name} and its files will be deleted.`)).toHaveClass("wrap-anywhere");
    expect(popup).toContainElement(screen.getByRole("button", { name: "Cancel" }));
  });
});
