import { QueryClient, QueryClientProvider, useSuspenseQuery } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { DefaultModelOrder } from "./default-model-order.tsx";
import { updateDefaultModelOrder } from "../server/functions.ts";

vi.mock("../server/functions.ts", () => ({ updateDefaultModelOrder: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
const saveMock = vi.mocked(updateDefaultModelOrder);
const model = (id: string, displayName: string, defaultPriority: number | null) => ({
  id,
  displayName,
  defaultPriority,
  providerId: "p",
  type: "chat" as "chat" | "embedding",
  enabled: true,
});
const initial = [
  model("a", "Alpha", 0),
  model("b", "Beta", null),
  { ...model("c", "Charlie", 1), enabled: false },
  { ...model("e", "Embedding", null), type: "embedding" as const },
];

const setup = () => {
  let stored = initial.map((entry) => ({ ...entry }));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["admin", "models"], stored);
  saveMock.mockImplementation(async ({ data }) => {
    stored = stored.map((entry) => ({
      ...entry,
      defaultPriority: data.modelIds.includes(entry.id) ? data.modelIds.indexOf(entry.id) : null,
    }));
  });
  function Probe() {
    const { data } = useSuspenseQuery({
      queryKey: ["admin", "models"],
      queryFn: async () => stored,
    });
    return (
      <DefaultModelOrder models={data} providers={[{ id: "p", name: "Provider", enabled: true }]} />
    );
  }
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  return {
    client,
    refresh: (models: typeof stored) =>
      act(() => {
        stored = models;
        client.setQueryData(["admin", "models"], stored);
      }),
  };
};
const names = () =>
  screen
    .queryAllByRole("listitem")
    .map((item) => within(item).getByText(/· Provider|Unavailable model/).textContent);
const button = (name: string) => screen.getByRole("button", { name });

beforeEach(() => vi.clearAllMocks());

describe("DefaultModelOrder", () => {
  it("shows priority, disabled status, boundary controls and no initial save", () => {
    setup();
    expect(names()).toEqual(["Alpha · Provider", "Charlie · Provider"]);
    expect(screen.getByText("Disabled · skipped")).toBeInTheDocument();
    expect(button("Move Alpha · Provider up")).toBeDisabled();
    expect(button("Move Charlie · Provider down")).toBeDisabled();
    expect(button("Save")).toBeDisabled();
  });

  it("adds an unranked chat model once and saves the reordered list", async () => {
    const { client } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const user = userEvent.setup();
    fireEvent.click(screen.getByRole("combobox", { name: "Model to add" }));
    // The option's accessible name concatenates the name and provider spans.
    const option = await screen.findByRole("option", { name: /^Beta\s*Provider$/ });
    expect(screen.queryByRole("option", { name: /Embedding/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Alpha/ })).not.toBeInTheDocument();
    await user.click(option);
    await user.click(button("Add model"));
    expect(button("Add model")).toBeDisabled();
    await user.click(button("Move Beta · Provider up"));
    await user.click(button("Remove Charlie · Provider"));
    expect(names()).toEqual(["Alpha · Provider", "Beta · Provider"]);
    await user.click(button("Save"));
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith({ data: { modelIds: ["a", "b"] } }));
    // The button confirms in place once the save lands.
    expect(await screen.findByRole("button", { name: "Saved" })).not.toHaveAttribute("aria-busy");
    expect(names()).toEqual(["Alpha · Provider", "Beta · Provider"]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["chat-models"] });
  });

  it("resets unsaved edits and can save an empty order", async () => {
    setup();
    fireEvent.click(button("Clear order"));
    expect(names()).toEqual([]);
    fireEvent.click(button("Reset"));
    expect(names()).toEqual(["Alpha · Provider", "Charlie · Provider"]);
    expect(saveMock).not.toHaveBeenCalled();
    fireEvent.click(button("Clear order"));
    fireEvent.click(button("Save"));
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith({ data: { modelIds: [] } }));
    expect(await screen.findByRole("button", { name: "Saved" })).not.toHaveAttribute("aria-busy");
    expect(names()).toEqual([]);
  });

  it("locks all editing controls while saving and retains the draft on rejection", async () => {
    setup();
    let reject!: (reason: unknown) => void;
    saveMock.mockImplementation(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    fireEvent.click(button("Move Charlie · Provider up"));
    fireEvent.click(button("Save"));
    await waitFor(() => expect(button("Save")).toHaveAttribute("aria-busy", "true"));
    expect(button("Save")).toHaveTextContent("Save");
    for (const control of screen.getAllByRole("button")) expect(control).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Model to add" })).toBeDisabled();
    await act(async () => reject(new Error("failed")));
    await waitFor(() => expect(button("Save")).toBeEnabled());
    expect(names()).toEqual(["Charlie · Provider", "Alpha · Provider"]);
    expect(toast.error).toHaveBeenCalled();
  });

  it("preserves dirty edits across policy refetches; Reset takes the latest saved order", async () => {
    const { refresh } = setup();
    fireEvent.click(button("Move Charlie · Provider up"));
    refresh(
      initial.map((entry) => ({
        ...entry,
        displayName: entry.id === "c" ? "Updated Charlie" : entry.displayName,
        defaultPriority: entry.id === "b" ? 0 : null,
      })),
    );
    await waitFor(() =>
      expect(names()).toEqual(["Updated Charlie · Provider", "Alpha · Provider"]),
    );
    fireEvent.click(button("Reset"));
    expect(names()).toEqual(["Beta · Provider"]);
  });

  it("keeps stale draft entries visible and prevents saving until they are removed", async () => {
    const { refresh } = setup();
    fireEvent.click(button("Move Charlie · Provider up"));
    refresh(initial.filter((entry) => entry.id !== "c"));
    expect(await screen.findByText("Remove this entry before saving.")).toBeInTheDocument();
    expect(button("Save")).toBeDisabled();
    fireEvent.click(button("Remove Unavailable model"));
    expect(names()).toEqual(["Alpha · Provider"]);
  });
});
