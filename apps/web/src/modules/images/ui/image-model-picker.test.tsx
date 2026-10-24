import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DropdownMenu, DropdownMenuContent } from "~/ui/primitives/dropdown-menu";
import { ImageModelMenu } from "./image-model-picker.tsx";

vi.mock("../server/functions.ts", () => ({
  listImageModels: vi.fn(),
}));

const model = (id: string, displayName: string) => ({
  id,
  displayName,
  description: null,
  imageCapabilities: null,
  providerName: "P",
  isDefault: false,
});

const renderPicker = (
  value: string | null,
  agentPreference: string | null,
  lock: string | null = null,
) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    ["image-models"],
    [model("a", "First"), model("b", "Agent’s"), model("c", "Kept")],
  );
  return render(
    <QueryClientProvider client={client}>
      <DropdownMenu open>
        <DropdownMenuContent>
          <ImageModelMenu
            value={value}
            lock={lock}
            agentPreference={agentPreference}
            onChange={vi.fn()}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </QueryClientProvider>,
  );
};

describe("ImageModelMenu", () => {
  it("shows the chat's model while it is usable", () => {
    renderPicker("a", "b");
    expect(screen.getByRole("menuitem", { name: /^Image model\s?First$/ })).toBeInTheDocument();
  });

  it("shows the agent's model when the chat's went away, as the server falls back", () => {
    renderPicker("gone", "b");
    expect(screen.getByRole("menuitem", { name: /^Image model\s?Agent’s$/ })).toBeInTheDocument();
  });

  it("shows the admin's first when neither is usable", () => {
    renderPicker("gone", "also-gone");
    expect(screen.getByRole("menuitem", { name: /^Image model\s?First$/ })).toBeInTheDocument();
  });

  it("shows the chat's own model when the pick went away, before the agent's", () => {
    renderPicker("gone", "b", "c");
    expect(screen.getByRole("menuitem", { name: /^Image model\s?Kept$/ })).toBeInTheDocument();
  });
});
