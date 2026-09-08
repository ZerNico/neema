import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillImportPage } from "./skill-import-page.tsx";

const searchDiscoverableSkills = vi.fn();
const reviewRemoteSkill = vi.fn();
const importReviewedSkill = vi.fn();
vi.mock("../server/import-functions.ts", () => ({
  searchDiscoverableSkills: (...args: unknown[]) => searchDiscoverableSkills(...args),
  reviewRemoteSkill: (...args: unknown[]) => reviewRemoteSkill(...args),
  importReviewedSkill: (...args: unknown[]) => importReviewedSkill(...args),
}));
vi.mock("../server/functions.ts", () => ({ saveSkill: vi.fn() }));
vi.mock("~/ui/confirm.tsx", () => ({ useConfirm: () => async () => true }));
vi.mock("./text-editor.tsx", () => ({
  default: ({ label }: { label: string }) => <textarea aria-label={label} readOnly />,
}));
const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  Link: ({ children, ...props }: { children?: unknown; to?: string }) => (
    <a href={props.to}>{children as never}</a>
  ),
  useMatches: () => [{ pathname: "/skills/import" }],
}));

function renderPage(props: { source?: string; path?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SkillImportPage {...props} />
    </QueryClientProvider>,
  );
}
const field = () => screen.getByRole("textbox", { name: "Search skills or paste a link" });

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("SkillImportPage", () => {
  it("waits for a real query before searching, and never searches a link", async () => {
    searchDiscoverableSkills.mockResolvedValue({
      skills: [{ skillId: "review", name: "review", source: "owner/repo", installs: 12 }],
      received: 1,
    });
    renderPage();
    fireEvent.change(field(), { target: { value: "r" } });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(searchDiscoverableSkills).not.toHaveBeenCalled();

    fireEvent.change(field(), { target: { value: "re" } });
    await waitFor(() => expect(searchDiscoverableSkills).toHaveBeenCalledTimes(1));
    expect(searchDiscoverableSkills.mock.calls[0]![0]).toMatchObject({ data: { query: "re" } });
    expect(await screen.findByText("owner/repo · 12 installs")).toBeVisible();

    // A pasted link is a package to fetch, not a search term.
    fireEvent.change(field(), { target: { value: "https://github.com/owner/repo" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Review package" })).toBeVisible(),
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(searchDiscoverableSkills).toHaveBeenCalledTimes(1);
  });

  it("opens a result as its own screen, and imports only on a second, explicit step", async () => {
    searchDiscoverableSkills.mockResolvedValue({
      skills: [{ skillId: "review", name: "review", source: "owner/repo", installs: 12 }],
      received: 1,
    });
    renderPage();
    fireEvent.change(field(), { target: { value: "review" } });
    fireEvent.click(await screen.findByText("review"));
    // Opening is a navigation, so Back and a refresh belong to the router.
    expect(navigate).toHaveBeenCalledWith({
      to: "/skills/import",
      search: { source: "https://skills.sh/owner/repo/review" },
    });

    let release: (value: unknown) => void = () => {};
    reviewRemoteSkill.mockReturnValue(new Promise((resolve) => (release = resolve)));
    renderPage({ source: "https://skills.sh/owner/repo/review" });
    // The wait has the screen to itself, not a spinner inside a result row.
    expect(await screen.findByLabelText("Reading the package")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Import skill" })).toBeNull();
    release({
      token: "t1",
      repository: "owner/repo",
      commit: "a".repeat(40),
      choices: [],
      selected: {
        source: { path: "skills/review" },
        package: {
          files: [{ path: "SKILL.md", content: "body" }],
          metadata: { name: "review", description: "d", manualOnly: false },
          findings: [],
        },
      },
    });
    expect(await screen.findByRole("button", { name: "Import skill" })).toBeVisible();
    expect(screen.getByText(/owner\/repo\/skills\/review/)).toBeVisible();
    // One way back: the header arrow, not a second Back control beside it.
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.getByRole("button", { name: "Import" })).toBeVisible();
  });
  it("shows result-shaped skeletons while searching, and keeps results while widening", async () => {
    let release: (value: unknown) => void = () => {};
    searchDiscoverableSkills.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    renderPage();
    fireEvent.change(field(), { target: { value: "review" } });
    expect(await screen.findByLabelText("Searching skills.sh")).toBeVisible();
    expect(screen.queryByText("Searching…")).toBeNull();
    release({
      skills: [{ skillId: "review", name: "review", source: "owner/repo", installs: 12 }],
      received: 20,
    });
    expect(await screen.findByText("review")).toBeVisible();
    expect(screen.queryByLabelText("Searching skills.sh")).toBeNull();

    // Widening the page keeps what is already on screen rather than emptying
    // it, and the next rows are marked where they will land.
    searchDiscoverableSkills.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText("review")).toBeVisible();
    expect(screen.queryByLabelText("Searching skills.sh")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });
  it("offers more results when a full page came back, even if a row was dropped", async () => {
    // 20 returned, 18 addressable: the button must follow what the endpoint
    // sent, not how many rows survived filtering.
    searchDiscoverableSkills.mockResolvedValue({
      skills: Array.from({ length: 18 }, (_, index) => ({
        skillId: `skill-${index}`,
        name: `Skill ${index}`,
        source: "owner/repo",
        installs: index,
      })),
      received: 20,
    });
    renderPage();
    fireEvent.change(field(), { target: { value: "review" } });
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    await waitFor(() =>
      expect(searchDiscoverableSkills).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: { query: "review", limit: 60 } }),
      ),
    );
  });
  it("returns to the library after importing", async () => {
    reviewRemoteSkill.mockResolvedValue({
      repository: "owner/repo",
      commit: "a".repeat(40),
      choices: [],
      selected: {
        source: {
          repository: "owner/repo",
          commit: "a".repeat(40),
          path: "skills/review",
          contentHash: "h1",
        },
        package: {
          files: [{ path: "SKILL.md", content: "body" }],
          metadata: { name: "review", description: "d", manualOnly: false },
          findings: [],
        },
      },
    });
    importReviewedSkill.mockResolvedValue("skill-1");
    renderPage({ source: "https://skills.sh/owner/repo/review" });
    fireEvent.click(await screen.findByRole("button", { name: "Import skill" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/skills" }));
    expect(importReviewedSkill).toHaveBeenCalledWith({
      data: {
        repository: "owner/repo",
        commit: "a".repeat(40),
        path: "skills/review",
        contentHash: "h1",
      },
    });
  });
  it("does not navigate to a refusal that came back in place of an id", async () => {
    reviewRemoteSkill.mockResolvedValue({
      token: "t1",
      repository: "owner/repo",
      commit: "a".repeat(40),
      choices: [],
      selected: {
        source: { path: "skills/review" },
        package: {
          files: [{ path: "SKILL.md", content: "body" }],
          metadata: { name: "review", description: "d", manualOnly: false },
          findings: [],
        },
      },
    });
    // A refused server function can resolve with the Response it threw.
    importReviewedSkill.mockResolvedValue(
      new Response("Import review expired. Review the package again.", { status: 409 }),
    );
    renderPage({ source: "https://skills.sh/owner/repo/review" });
    fireEvent.click(await screen.findByRole("button", { name: "Import skill" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Import review expired");
    expect(navigate).not.toHaveBeenCalled();
  });
  it("keeps the link and upload paths usable when discovery is down", async () => {
    searchDiscoverableSkills.mockRejectedValue(new Error("skills.sh unavailable"));
    renderPage();
    fireEvent.change(field(), { target: { value: "review" } });
    expect(await screen.findByText("Discovery is unavailable")).toBeVisible();
    expect(screen.getByLabelText("Upload a Markdown or ZIP package")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });
});
