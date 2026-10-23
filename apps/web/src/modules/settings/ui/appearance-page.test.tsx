import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { themeInitScript } from "~/ui/theme.tsx";
import { AppearancePage } from "./appearance-page.tsx";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: unknown }) => (
    <a href={to}>{children as never}</a>
  ),
}));

beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  delete document.documentElement.dataset.scheme;
  document.documentElement.classList.remove("dark");
});

describe("AppearancePage", () => {
  it("applies and remembers the chosen theme on this device", () => {
    render(<AppearancePage />);
    expect(screen.getByRole("radio", { name: /Iris/ })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("radio", { name: /Sage/ }));

    expect(document.documentElement.dataset.scheme).toBe("sage");
    expect(localStorage.getItem("scheme")).toBe("sage");
    expect(screen.getByRole("radio", { name: /Sage/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /Iris/ })).toHaveAttribute("aria-checked", "false");

    // The default is the absence of a choice, so a later default change reaches it.
    fireEvent.click(screen.getByRole("radio", { name: /Iris/ }));
    expect(localStorage.getItem("scheme")).toBeNull();
    expect(document.documentElement.dataset.scheme).toBe("iris");
  });
});

describe("AppearancePage mode", () => {
  it("switches between light, system and dark", () => {
    render(<AppearancePage />);
    expect(screen.getByRole("radio", { name: /System/ })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("radio", { name: /Dark/ }));

    expect(localStorage.getItem("theme")).toBe("dark");
    expect(document.documentElement).toHaveClass("dark");
    expect(screen.getByRole("radio", { name: /Dark/ })).toHaveAttribute("aria-checked", "true");
  });
});

describe("themeInitScript", () => {
  it("sets the stored theme before paint and ignores one it does not know", () => {
    localStorage.setItem("scheme", "clay");
    new Function(themeInitScript)();
    expect(document.documentElement.dataset.scheme).toBe("clay");

    localStorage.setItem("scheme", "neon");
    new Function(themeInitScript)();
    expect(document.documentElement.dataset.scheme).toBe("iris");
  });

  it("gives the title bar the stored theme's colour before the page draws", () => {
    const metas = () => [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
    // The test above ran the script too.
    for (const meta of metas()) meta.remove();
    localStorage.setItem("theme", "dark");
    new Function(themeInitScript)();
    expect(metas().map((meta) => meta.content)).toEqual(["#171717"]);
  });
});
