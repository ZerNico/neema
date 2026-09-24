import { QueryClient, QueryClientProvider, useSuspenseQuery } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    .map((item) => item.querySelector("[title]")?.getAttribute("title"));
const button = (name: string) => screen.getByRole("button", { name });

beforeEach(() => vi.clearAllMocks());

describe("DefaultModelOrder", () => {
  it("shows priority, provider, skipped status and boundary controls without saving", () => {
    setup();
    expect(names()).toEqual(["Alpha", "Charlie"]);
    expect(screen.getByText("Provider · Disabled, skipped")).toBeInTheDocument();
    expect(button("Move Alpha · Provider up")).toBeDisabled();
    expect(button("Move Charlie · Provider down")).toBeDisabled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("adds a chat model on pick and saves every change as it is made", async () => {
    const { client } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const user = userEvent.setup();
    fireEvent.click(screen.getByRole("combobox", { name: "Add a model" }));
    // The option's accessible name concatenates the name and provider spans.
    const option = await screen.findByRole("option", { name: /^Beta\s*Provider$/ });
    expect(screen.queryByRole("option", { name: /Embedding/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Alpha/ })).not.toBeInTheDocument();
    await user.click(option);
    await waitFor(() =>
      expect(saveMock).toHaveBeenLastCalledWith({ data: { modelIds: ["a", "c", "b"] } }),
    );
    await user.click(button("Move Beta · Provider up"));
    await user.click(button("Remove Charlie · Provider"));
    expect(names()).toEqual(["Alpha", "Beta"]);
    await waitFor(() =>
      expect(saveMock).toHaveBeenLastCalledWith({ data: { modelIds: ["a", "b"] } }),
    );
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["chat-models"] }));
    expect(names()).toEqual(["Alpha", "Beta"]);
  });

  it("keeps controls usable while a save runs and queues the next one behind it", async () => {
    setup();
    let finishFirst!: () => void;
    saveMock.mockImplementationOnce(() => new Promise<void>((done) => (finishFirst = done)));
    fireEvent.click(button("Move Charlie · Provider up"));
    expect(names()).toEqual(["Charlie", "Alpha"]);
    const remove = button("Remove Alpha · Provider");
    expect(remove).toBeEnabled();
    fireEvent.click(remove);
    expect(names()).toEqual(["Charlie"]);
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    finishFirst();
    await waitFor(() => expect(saveMock).toHaveBeenLastCalledWith({ data: { modelIds: ["c"] } }));
  });

  it("reports a failed save and shows what the server kept", async () => {
    setup();
    saveMock.mockRejectedValueOnce(new Error("failed"));
    fireEvent.click(button("Move Charlie · Provider up"));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() => expect(names()).toEqual(["Alpha", "Charlie"]));
  });

  it("drops a model deleted elsewhere instead of blocking the list", async () => {
    const { refresh } = setup();
    refresh(initial.filter((entry) => entry.id !== "c"));
    await waitFor(() => expect(names()).toEqual(["Alpha"]));
    fireEvent.click(button("Remove Alpha · Provider"));
    await waitFor(() => expect(saveMock).toHaveBeenLastCalledWith({ data: { modelIds: [] } }));
    expect(
      screen.getByText(
        "No models listed yet, so new chats start with the first model alphabetically.",
      ),
    ).toBeInTheDocument();
  });
});
