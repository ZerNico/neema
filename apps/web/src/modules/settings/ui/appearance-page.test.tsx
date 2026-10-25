import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render as renderInto, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseLanguage } from "~/modules/language/server/functions.ts";
import { themeInitScript } from "~/ui/theme.tsx";
import { AppearancePage } from "./appearance-page.tsx";

vi.mock("~/modules/language/server/functions.ts", () => ({
  getLanguage: vi.fn(),
  chooseLanguage: vi.fn().mockResolvedValue(undefined),
  noteBrowserLanguage: vi.fn(),
}));

const render = (page: ReactElement) => {
  const client = new QueryClient();
  client.setQueryData(["language"], { chosen: null });
  return renderInto(<QueryClientProvider client={client}>{page}</QueryClientProvider>);
};

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

    fireEvent.click(screen.getByRole("radio", { name: /Matcha/ }));

    expect(document.documentElement.dataset.scheme).toBe("matcha");
    expect(localStorage.getItem("scheme")).toBe("matcha");
    expect(screen.getByRole("radio", { name: /Matcha/ })).toHaveAttribute("aria-checked", "true");
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

describe("AppearancePage language", () => {
  it("follows the browser until a language is chosen, then saves it to the account", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...location, reload });
    render(<AppearancePage />);
    expect(screen.getByRole("radio", { name: "Automatic" })).toBeChecked();
    expect(screen.getByText("Follows your browser, now English")).toBeVisible();

    fireEvent.click(screen.getByRole("radio", { name: "Deutsch" }));

    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(chooseLanguage).toHaveBeenCalledWith({ data: { chosen: "de" } });
    expect(document.cookie).toContain("language=de");
    document.cookie = "language=; path=/; max-age=0";
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

  it("carries a retired scheme over to its successor", () => {
    localStorage.setItem("scheme", "amber");
    new Function(themeInitScript)();
    expect(document.documentElement.dataset.scheme).toBe("cherry");
    expect(localStorage.getItem("scheme")).toBe("cherry");
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
