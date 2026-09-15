import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  type AnyRoute,
} from "@tanstack/react-router";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RouteError, RouteNotFound } from "./route-error.tsx";

async function renderAt(path: string, routeTree: AnyRoute) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: RouteNotFound,
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return router;
}

describe("route error screens", () => {
  it("shows a retryable error after a loader failure", async () => {
    const error = new Error("boom");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = createRootRoute();
    const index = createRoute({
      getParentRoute: () => root,
      path: "/",
      loader: () => {
        throw error;
      },
      errorComponent: RouteError,
      component: () => <div>ok</div>,
    });
    const router = await renderAt("/", root.addChildren([index]));
    const invalidate = vi.spyOn(router, "invalidate");

    expect(screen.getByRole("alert")).toHaveTextContent("Could not load this page");
    expect(screen.getByRole("link", { name: "Back to chats" })).toHaveAttribute("href", "/chats");
    expect(consoleError).toHaveBeenCalledWith(error);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(invalidate).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("shows the not-found card for an unmatched URL", async () => {
    const root = createRootRoute({ notFoundComponent: RouteNotFound });
    const index = createRoute({
      getParentRoute: () => root,
      path: "/",
      component: () => <div>home</div>,
    });
    await renderAt("/missing", root.addChildren([index]));

    expect(screen.getByText("Page not found")).toBeVisible();
    expect(screen.getByRole("link", { name: "Back to chats" })).toHaveAttribute("href", "/chats");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
