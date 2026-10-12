import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_CAPABILITIES } from "~/modules/groups/policy.ts";
import type { SkillDetail, SkillSaveResult } from "../schema.ts";
import type { SkillFile } from "../package.ts";
import { getSkill, getSkillDetail, saveSkill } from "../server/functions.ts";
import { uploadSkillFile } from "../client/files.ts";
import { SkillEditorPage } from "./skill-editor-page.tsx";

vi.mock("../server/functions.ts", () => ({
  getSkill: vi.fn(),
  getSkillDetail: vi.fn(),
  saveSkill: vi.fn(),
  deleteSkill: vi.fn(),
}));
vi.mock("../client/files.ts", async (original) => ({
  ...(await original<typeof import("../client/files.ts")>()),
  uploadSkillFile: vi.fn(),
}));
vi.mock("~/ui/confirm-context.ts", () => ({ useConfirm: () => async () => true }));
vi.mock("./text-editor.tsx", () => ({
  default: ({
    value,
    onChange,
    label,
  }: {
    value: string;
    onChange: (value: string) => void;
    label: string;
  }) => (
    <textarea aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => navigate,
  useBlocker: vi.fn(),
  useMatches: () => [{ pathname: "/skills/s1" }],
}));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const root = {
  path: "SKILL.md",
  content:
    "---\nname: draft-test\ndescription: A synthetic test skill.\n---\n# Instructions\nKeep the draft.",
};
const binary = (sha256: string): SkillFile => ({
  path: "assets/brand.ttf",
  binary: { sha256, size: 3, mediaType: "font/ttf" },
});
const detail = (files: SkillFile[], revision = 1): SkillDetail => ({
  id: "s1",
  name: "draft-test",
  description: "A synthetic test skill.",
  manualOnly: false,
  audience: "private",
  canEdit: true,
  ownerName: null,
  revision,
  updatedAt: "2026-10-12",
  files,
  findings: [],
  source: null,
  revisionId: `r${revision}`,
});

beforeEach(() => vi.resetAllMocks());

function setup() {
  const original = detail([root, binary("0".repeat(64))]);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["capabilities"], ALL_CAPABILITIES);
  client.setQueryData(["skills", "s1", "metadata"], original);
  client.setQueryData(["skills", "s1", "owner"], original);
  vi.mocked(getSkill).mockResolvedValue(original);
  const saved = detail([root, binary("a".repeat(64))], 2);
  vi.mocked(getSkillDetail).mockResolvedValue(saved);
  const pendingSave = deferred<SkillSaveResult>();
  const pendingDetail = deferred<SkillDetail>();
  vi.mocked(saveSkill).mockReturnValueOnce(pendingSave.promise);
  vi.mocked(getSkillDetail).mockReturnValueOnce(pendingDetail.promise);
  vi.mocked(uploadSkillFile).mockResolvedValueOnce({
    uploadId: "A",
    size: 3,
    mediaType: "font/ttf",
  });
  vi.mocked(uploadSkillFile).mockResolvedValueOnce({
    uploadId: "B",
    size: 3,
    mediaType: "font/ttf",
  });
  const rendered = render(
    <QueryClientProvider client={client}>
      <SkillEditorPage skillId="s1" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
  fireEvent.click(screen.getByRole("button", { name: "brand.ttf" }));
  const replace = () => {
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    fireEvent.change(rendered.container.querySelectorAll('input[type="file"]')[1]!, {
      target: { files: [new File([new Uint8Array([0, 1, 255])], "brand.ttf")] },
    });
  };
  const settle = async () => {
    await act(async () => pendingSave.resolve(saved));
    await waitFor(() => expect(getSkillDetail).toHaveBeenCalled());
    await act(async () => pendingDetail.resolve(saved));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Saved" })).not.toHaveAttribute("aria-busy"),
    );
  };
  const submitA = async () => {
    replace();
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
        "href",
        "/api/files/A",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saveSkill).toHaveBeenCalledOnce());
  };
  return { ...rendered, replace, settle, submitA, pendingSave, pendingDetail, saved };
}

describe("skill save settlement", () => {
  it("keeps a new skill locked during creation and opens its accepted page", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(["capabilities"], ALL_CAPABILITIES);
    const pending = deferred<SkillSaveResult>();
    vi.mocked(saveSkill).mockReturnValueOnce(pending.promise);
    render(
      <QueryClientProvider client={client}>
        <SkillEditorPage />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "draft-test" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "When to use it" }), {
      target: { value: "A synthetic test skill." },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), {
      target: { value: "Keep the draft." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create skill" }));
    await waitFor(() => expect(saveSkill).toHaveBeenCalledOnce());
    expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
    await act(async () => pending.resolve({ id: "s1", revision: 1, files: [root] }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/skills/$skillId",
        params: { skillId: "s1" },
        ignoreBlocker: true,
      }),
    );
    expect(getSkillDetail).not.toHaveBeenCalled();
  });

  it("keeps an unchanged accepted draft clean when the server sorts its file list", async () => {
    const { container, pendingSave, pendingDetail } = setup();
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File([new Uint8Array([0, 1, 255])], "another.ttf")] },
    });
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
        "href",
        "/api/files/A",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saveSkill).toHaveBeenCalledOnce());
    const acceptedFiles: SkillFile[] = [
      root,
      { ...binary("a".repeat(64)), path: "assets/another.ttf" },
      binary("0".repeat(64)),
    ];
    await act(async () => pendingSave.resolve({ id: "s1", revision: 2, files: acceptedFiles }));
    await act(async () => pendingDetail.resolve(detail(acceptedFiles, 2)));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Saved" })).not.toHaveAttribute("aria-busy"),
    );
    expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled();
  });

  it("retains replacement B while save A and its detail read finish", async () => {
    const { replace, settle, submitA } = setup();
    await submitA();
    replace();
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
        "href",
        "/api/files/B",
      ),
    );
    await settle();
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/files/B");
    expect(screen.getByRole("button", { name: "Saved" })).toBeEnabled();
    vi.mocked(saveSkill).mockResolvedValueOnce({
      id: "s1",
      revision: 3,
      files: [root, binary("b".repeat(64))],
    });
    fireEvent.click(screen.getByRole("button", { name: "Saved" }));
    await waitFor(() =>
      expect(saveSkill).toHaveBeenLastCalledWith({
        data: expect.objectContaining({
          expectedRevision: 2,
          files: expect.arrayContaining([
            { path: "assets/brand.ttf", binary: { uploadId: "B", size: 3, mediaType: "font/ttf" } },
          ]),
        }),
      }),
    );
  });

  it("settles unchanged A and marks only that accepted draft clean", async () => {
    const { settle, submitA } = setup();
    await submitA();
    await settle();
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      `/api/skills/s1/files?sha256=${"a".repeat(64)}`,
    );
    expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled();
  });

  it("retains a rename while settling the same submitted upload identity", async () => {
    const { settle, submitA } = setup();
    await submitA();
    fireEvent.click(screen.getByRole("button", { name: "Rename assets/brand.ttf" }));
    const name = screen.getByRole("textbox", { name: "New name" });
    fireEvent.change(name, { target: { value: "renamed.ttf" } });
    fireEvent.keyDown(name, { key: "Enter" });
    await screen.findByRole("button", { name: "renamed.ttf" });
    await settle();
    expect(screen.getByRole("button", { name: "renamed.ttf" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      `/api/skills/s1/files?sha256=${"a".repeat(64)}`,
    );
    expect(screen.getByRole("button", { name: "Saved" })).toBeEnabled();
  });

  it("does not restore a deleted file after save", async () => {
    const { settle, submitA } = setup();
    await submitA();
    fireEvent.click(screen.getByRole("button", { name: "Delete assets/brand.ttf" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "brand.ttf" })).toBeNull());
    await settle();
    expect(screen.queryByRole("button", { name: "brand.ttf" })).toBeNull();
    expect(screen.getByRole("button", { name: "Saved" })).toBeEnabled();
  });

  it("preserves a later text replacement instead of restoring submitted binary A", async () => {
    const { container, submitA, settle } = setup();
    await submitA();
    fireEvent.click(screen.getByRole("button", { name: "Rename assets/brand.ttf" }));
    const name = screen.getByRole("textbox", { name: "New name" });
    fireEvent.change(name, { target: { value: "notes.md" } });
    fireEvent.keyDown(name, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    fireEvent.change(container.querySelectorAll('input[type="file"]')[1]!, {
      target: { files: [new File(["Later text"], "notes.md")] },
    });
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Edit assets/notes.md" })).toHaveValue(
        "Later text",
      ),
    );
    await settle();
    expect(screen.getByRole("button", { name: "Saved" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Edit assets/notes.md" })).toHaveValue("Later text");
    expect(screen.queryByRole("button", { name: "brand.ttf" })).toBeNull();
  });

  it("settles A without replacing an unrelated later upload", async () => {
    const { container, submitA, settle } = setup();
    await submitA();
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File([new Uint8Array([0, 1, 255])], "later.ttf")] },
    });
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
        "href",
        "/api/files/B",
      ),
    );
    await settle();
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/files/B");
    fireEvent.click(screen.getByRole("button", { name: "brand.ttf" }));
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      `/api/skills/s1/files?sha256=${"a".repeat(64)}`,
    );
    expect(screen.getByRole("button", { name: "Saved" })).toBeEnabled();
  });

  it("uses accepted revision 2 A even when latest detail is revision 3 C", async () => {
    const { submitA, pendingSave, pendingDetail, saved } = setup();
    await submitA();
    await act(async () => pendingSave.resolve(saved));
    await waitFor(() => expect(getSkillDetail).toHaveBeenCalled());
    await act(async () => pendingDetail.resolve(detail([root, binary("c".repeat(64))], 3)));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Saved" })).not.toHaveAttribute("aria-busy"),
    );
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      `/api/skills/s1/files?sha256=${"a".repeat(64)}`,
    );
    expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Rename assets/brand.ttf" }));
    const name = screen.getByRole("textbox", { name: "New name" });
    fireEvent.change(name, { target: { value: "renamed.ttf" } });
    fireEvent.keyDown(name, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Saved" }));
    await waitFor(() =>
      expect(saveSkill).toHaveBeenLastCalledWith({
        data: expect.objectContaining({
          expectedRevision: 2,
          files: expect.arrayContaining([
            {
              path: "assets/renamed.ttf",
              binary: { sha256: "a".repeat(64), size: 3, mediaType: "font/ttf" },
            },
          ]),
        }),
      }),
    );
  });

  it("settles consumed A without any successful latest-detail read", async () => {
    const { submitA, pendingSave, pendingDetail, saved } = setup();
    await submitA();
    await act(async () => pendingSave.resolve(saved));
    await waitFor(() => expect(getSkillDetail).toHaveBeenCalled());
    await act(async () => pendingDetail.reject(new Error("Offline")));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Saved" })).not.toHaveAttribute("aria-busy"),
    );
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      `/api/skills/s1/files?sha256=${"a".repeat(64)}`,
    );
    expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
