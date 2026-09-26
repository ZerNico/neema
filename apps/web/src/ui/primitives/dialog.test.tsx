import { render, screen } from "@testing-library/react";
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
