import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Streamdown } from "streamdown";
import { afterEach, expect, it, vi } from "vitest";
import { markdownTableComponents } from "./markdown-components.ts";

const TABLE = ["| Tag | Distanz |", "| --- | --- |", "| 1 | 72 km |", "| 2 | 70 km |"].join("\n");

afterEach(() => {
  vi.unstubAllGlobals();
});

it("draws a Markdown table with the app's controls in place of Streamdown's", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  render(
    <Streamdown mode="static" components={markdownTableComponents}>
      {TABLE}
    </Streamdown>,
  );
  const table = await screen.findByRole("table");
  expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
  // Streamdown's own frame and its native-title buttons are gone.
  expect(document.querySelector('[data-streamdown="table-wrapper"]')).toBeNull();
  expect(document.querySelector("button[title]")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Copy table" }));
  await act(async () => {
    fireEvent.click(await screen.findByRole("menuitem", { name: "CSV" }));
  });
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("Tag,Distanz\n1,72 km\n2,70 km"));
  expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
});
