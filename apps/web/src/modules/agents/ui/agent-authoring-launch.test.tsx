import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useLocation,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listChatModels, sendMessage } from "~/modules/chat/server/functions.ts";
import { agentAuthoringRequest } from "../authoring.ts";
import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import {
  AgentAuthoringLaunchButton,
  AgentAuthoringLaunchMenuItem,
} from "./agent-authoring-launch.tsx";

vi.mock("~/modules/chat/server/functions.ts", () => ({
  sendMessage: vi.fn(),
  listChatModels: vi.fn(),
}));
function Destination() {
  const location = useLocation();
  return <output>{location.state.chatPrefill}</output>;
}
async function fixture(content: ReactNode) {
  const root = createRootRoute();
  const home = createRoute({ getParentRoute: () => root, path: "/", component: Destination });
  const agents = createRoute({
    getParentRoute: () => root,
    path: "/agents",
    component: () => content,
  });
  const router = createRouter({
    routeTree: root.addChildren([home, agents]),
    history: createMemoryHistory({ initialEntries: ["/agents"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return router;
}
beforeEach(() => vi.clearAllMocks());

describe("agent authoring shortcuts", () => {
  it("navigates with an unsent creation request without looking up models or sending", async () => {
    const router = await fixture(<AgentAuthoringLaunchButton />);
    expect(router.state.location.pathname).toBe("/agents");
    fireEvent.click(await screen.findByRole("link", { name: "Create with chat" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(screen.getByRole("status")).toHaveTextContent(agentAuthoringRequest());
    expect(router.state.location.search).toEqual({});
    expect(sendMessage).not.toHaveBeenCalled();
    expect(listChatModels).not.toHaveBeenCalled();
  });
  it("references the exact edit target in readable text, without installing it", async () => {
    const router = await fixture(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Agent actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <AgentAuthoringLaunchMenuItem agentId="target-agent" />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit with chat" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(router.state.location.state.chatPrefill).toContain("[this agent](/agents/target-agent)");
    expect(router.state.location.search).toEqual({});
    expect(sendMessage).not.toHaveBeenCalled();
    expect(listChatModels).not.toHaveBeenCalled();
  });
  it("keeps an unavailable creation shortcut disabled", async () => {
    const router = await fixture(<AgentAuthoringLaunchButton disabled />);
    const shortcut = await screen.findByRole("button", { name: "Create with chat" });
    expect(shortcut).toBeDisabled();
    fireEvent.click(shortcut);
    expect(router.state.location.pathname).toBe("/agents");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
