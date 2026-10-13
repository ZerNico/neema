import { QueryClient, QueryClientProvider, useSuspenseQuery } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { ModelOrder } from "./model-order.tsx";
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
    return <ModelOrder models={data} providers={[{ id: "p", name: "Provider", enabled: true }]} />;
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

describe("ModelOrder", () => {
  it("lists every chat model, placed ones first, and marks the first usable as default", () => {
    setup();
    expect(names()).toEqual(["Alpha", "Charlie", "Beta"]);
    expect(screen.getByText("Provider · Disabled, skipped")).toBeInTheDocument();
    expect(screen.getAllByText("Default")).toHaveLength(1);
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("Default");
    expect(button("Move Alpha · Provider up")).toBeDisabled();
    expect(button("Move Beta · Provider down")).toBeDisabled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("saves the whole order on every move", async () => {
    const { client } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const user = userEvent.setup();
    await user.click(button("Move Beta · Provider up"));
    expect(names()).toEqual(["Alpha", "Beta", "Charlie"]);
    await waitFor(() =>
      expect(saveMock).toHaveBeenLastCalledWith({
        data: { modelIds: ["a", "b", "c"], type: "chat" },
      }),
    );
    await user.click(button("Move Alpha · Provider down"));
    await waitFor(() =>
      expect(saveMock).toHaveBeenLastCalledWith({
        data: { modelIds: ["b", "a", "c"], type: "chat" },
      }),
    );
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["chat-models"] }));
    expect(names()).toEqual(["Beta", "Alpha", "Charlie"]);
  });

  it("keeps controls usable while a save runs and queues the next one behind it", async () => {
    setup();
    let finishFirst!: () => void;
    saveMock.mockImplementationOnce(() => new Promise<void>((done) => (finishFirst = done)));
    fireEvent.click(button("Move Charlie · Provider up"));
    expect(names()).toEqual(["Charlie", "Alpha", "Beta"]);
    const down = button("Move Charlie · Provider down");
    expect(down).toBeEnabled();
    fireEvent.click(down);
    expect(names()).toEqual(["Alpha", "Charlie", "Beta"]);
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    finishFirst();
    await waitFor(() =>
      expect(saveMock).toHaveBeenLastCalledWith({
        data: { modelIds: ["a", "c", "b"], type: "chat" },
      }),
    );
  });

  it("reports a failed save and shows what the server kept", async () => {
    setup();
    saveMock.mockRejectedValueOnce(new Error("failed"));
    fireEvent.click(button("Move Charlie · Provider up"));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() => expect(names()).toEqual(["Alpha", "Charlie", "Beta"]));
  });

  it("follows models deleted or added elsewhere", async () => {
    const { refresh } = setup();
    refresh([...initial.filter((entry) => entry.id !== "c"), model("d", "Delta", null)]);
    await waitFor(() => expect(names()).toEqual(["Alpha", "Beta", "Delta"]));
  });
});
