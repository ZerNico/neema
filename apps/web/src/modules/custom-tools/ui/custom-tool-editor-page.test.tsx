import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { JsonValue } from "~/db/schema/providers.ts";
import type { CustomToolDetail } from "../schema.ts";
import {
  checkCustomTool,
  deleteCustomTool,
  saveCustomTool,
  setCustomToolEnabled,
  testCustomTool,
} from "../server/functions.ts";
import { getResourceSharing } from "~/modules/sharing/server/functions.ts";
import { CustomToolEditorPage } from "./custom-tool-editor-page.tsx";

const navigate = vi.fn();
const confirm = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const blocker = vi.hoisted(() => ({
  current: null as null | { shouldBlockFn: () => Promise<boolean>; enableBeforeUnload: boolean },
}));
vi.mock("../server/functions.ts", () => ({
  getCustomTool: vi.fn(),
  checkCustomTool: vi.fn(),
  saveCustomTool: vi.fn(),
  setCustomToolEnabled: vi.fn(),
  deleteCustomTool: vi.fn(),
  testCustomTool: vi.fn(),
}));
vi.mock("~/modules/sharing/server/functions.ts", () => ({
  getResourceSharing: vi.fn().mockResolvedValue({
    audience: "instance",
    canPublish: true,
    users: [],
    groups: [],
    eligibleGroups: [],
  }),
  searchShareRecipients: vi.fn().mockResolvedValue([]),
  shareResourceWithEmail: vi.fn(),
  shareResourceWithGroup: vi.fn(),
  revokeResourceUser: vi.fn(),
  revokeResourceGroup: vi.fn(),
  publishResource: vi.fn(),
}));
vi.mock("~/ui/confirm-context.ts", () => ({ useConfirm: () => confirm }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
  useMatches: () => [{ pathname: "/admin/custom-tools/t1" }],
  useNavigate: () => navigate,
  useBlocker: (options: typeof blocker.current) => {
    blocker.current = options;
  },
}));
// CodeMirror needs a real layout engine; swap it for a textarea, like the
// text-editor mocks in the skills and documents suites.
vi.mock("@codemirror/lint", () => ({
  lintGutter: () => [],
  setDiagnostics: () => ({}),
}));
vi.mock("@uiw/react-codemirror", () => ({
  EditorView: { theme: () => [], contentAttributes: { of: () => [] } },
  default: function MockCodeMirror({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) {
    return (
      <textarea
        aria-label="Source"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  },
}));

const functionManifest = {
  key: "current",
  name: "Current weather",
  description: "Read current weather.",
  modelName: "custom_weather_lookup__current",
  parametersSchema: {
    type: "object",
    required: ["city"],
    properties: { city: { type: "string", description: "City name" } },
  } as Record<string, JsonValue>,
} as const;

const detail = (overrides: Partial<CustomToolDetail> = {}): CustomToolDetail => ({
  id: "t1",
  slug: "weather_lookup",
  name: "Weather lookup",
  description: "Current weather for a city.",
  enabled: true,
  audience: "instance",
  version: "v1",
  functionCount: 1,
  dependencyCount: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
  source: 'import { defineModule } from "@chat/custom-tools";',
  dependencies: [],
  functions: [functionManifest],
  ...overrides,
});

const renderEditor = (tool?: CustomToolDetail) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (tool) client.setQueryData(["admin", "custom-tools", tool.id], tool);
  render(
    <QueryClientProvider client={client}>
      <Suspense fallback={null}>
        <CustomToolEditorPage {...(tool ? { toolId: tool.id } : {})} />
      </Suspense>
    </QueryClientProvider>,
  );
  return client;
};

beforeEach(() => {
  vi.clearAllMocks();
  blocker.current = null;
});

// The page's own save confirmation is a status too; these tests mean the other one.
const otherStatus = () =>
  screen.queryAllByRole("status").find((element) => element.dataset.slot !== "save-status") ?? null;

describe("CustomToolEditorPage", () => {
  it("derives the identifier from the name until it is edited, and gates Check on it", async () => {
    const user = userEvent.setup();
    renderEditor();
    const check = screen.getByRole("button", { name: "Verify" });
    expect(check).toBeDisabled();
    expect(screen.getByRole("button", { name: "Debug" })).toBeDisabled();

    await user.type(screen.getByLabelText("Name"), "Weather Tools!");
    expect(screen.getByLabelText("Identifier")).toHaveValue("weather_tools");
    expect(check).toBeEnabled();

    fireEvent.change(screen.getByLabelText("Identifier"), { target: { value: "Bad_" } });
    expect(screen.getByLabelText("Identifier")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/single underscores/)).toBeInTheDocument();
    expect(check).toBeDisabled();
    // A direct edit sticks: the name no longer drives it.
    await user.type(screen.getByLabelText("Name"), " more");
    expect(screen.getByLabelText("Identifier")).toHaveValue("Bad_");
  });

  it("creates without a description, then moves to the new module's page", async () => {
    const user = userEvent.setup();
    vi.mocked(saveCustomTool).mockResolvedValue(detail({ id: "created" }) as never);
    renderEditor();
    const create = screen.getByRole("button", { name: "Create module" });
    expect(create).toBeDisabled();
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("aria-invalid");

    await user.click(screen.getByLabelText("Name"));
    await user.tab();
    expect(screen.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");

    await user.type(screen.getByLabelText("Name"), "Echo");
    expect(create).toBeEnabled();
    await user.click(create);
    await waitFor(() =>
      expect(saveCustomTool).toHaveBeenCalledWith({
        data: expect.objectContaining({
          slug: "echo",
          name: "Echo",
          description: "",
        }),
      }),
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/admin/custom-tools/$toolId",
        params: { toolId: "created" },
      }),
    );
  });

  it("opens the shared Access dialog for a stored module", async () => {
    const user = userEvent.setup();
    renderEditor(detail());
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Access" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Weather lookup");
    expect(getResourceSharing).toHaveBeenCalledWith({
      data: { kind: "customTool", id: "t1" },
    });
  });

  it("lists a refused Check as problems, with type errors as line links", async () => {
    const user = userEvent.setup();
    // The Start client hands a thrown Response back as the resolved value.
    vi.mocked(checkCustomTool).mockResolvedValueOnce(
      new Response(
        JSON.stringify([{ path: ["dependencies", 0, "name"], message: "Expected a package name" }]),
        { status: 400 },
      ) as never,
    );
    vi.mocked(checkCustomTool).mockRejectedValueOnce(
      new Response(
        "TypeScript check failed:\ntool.ts(4,3): error TS2322: Type 'A' is not assignable.\n  Detail line.\ntool.ts(9,1): error TS2304: Cannot find name 'x'.",
        { status: 400 },
      ),
    );
    renderEditor();
    await user.type(screen.getByLabelText("Name"), "Weather");
    expect(otherStatus()).toBeNull();

    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Expected a package name");
    expect(otherStatus()).toHaveTextContent("1 problem");

    await user.click(screen.getByRole("button", { name: "Verify" }));
    const list = await screen.findByRole("alert");
    expect(otherStatus()).toHaveTextContent("2 problems");
    expect(within(list).getByRole("button", { name: "4:3" })).toBeInTheDocument();
    expect(list).toHaveTextContent("TS2322: Type 'A' is not assignable. Detail line.");
    expect(within(list).getByRole("button", { name: "9:1" })).toBeInTheDocument();
    expect(list).not.toHaveTextContent("TypeScript check failed");
  });

  it("puts a taken identifier on the field and clears it when the identifier changes", async () => {
    const user = userEvent.setup();
    vi.mocked(saveCustomTool).mockRejectedValueOnce(
      new Response("The slug echo is already in use.", { status: 409 }),
    );
    renderEditor();
    await user.type(screen.getByLabelText("Name"), "Echo");
    await user.click(screen.getByRole("button", { name: "Create module" }));
    const slug = await screen.findByLabelText("Identifier");
    await waitFor(() => expect(slug).toHaveAttribute("aria-invalid", "true"));
    expect(screen.getByText("That identifier is taken.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create module" })).toBeDisabled();

    fireEvent.change(slug, { target: { value: "echo_two" } });
    expect(slug).not.toHaveAttribute("aria-invalid");
    expect(screen.getByRole("button", { name: "Create module" })).toBeEnabled();
  });

  it("preloads the stored module when editing and keeps its identifier editable", async () => {
    renderEditor(detail({ audience: "private" }));
    expect(screen.getByRole("heading", { name: "Weather lookup" })).toBeInTheDocument();
    const slug = screen.getByLabelText("Identifier");
    expect(slug).toHaveValue("weather_lookup");
    expect(slug).toBeEnabled();
    expect(screen.getByLabelText("Name")).toHaveValue("Weather lookup");
    // A stored module is already verified, so Debug is ready without a fresh Verify.
    expect(otherStatus()).toBeNull();
    expect(screen.getByRole("button", { name: "Debug" })).toBeEnabled();
    // Save waits for an edit, which is how unsaved changes show.
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Weather lookup 2" } });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("renames a stored module, sending the new identifier with the version it loaded", async () => {
    const user = userEvent.setup();
    vi.mocked(saveCustomTool).mockResolvedValue(detail({ slug: "weather" }) as never);
    renderEditor(detail());
    const slug = screen.getByLabelText("Identifier");
    // A rename alone is a change: Save and the leave guard have to see it.
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    fireEvent.change(slug, { target: { value: "weather" } });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saveCustomTool).toHaveBeenCalled());
    expect(vi.mocked(saveCustomTool).mock.calls[0]![0]).toMatchObject({
      data: { toolId: "t1", expectedVersion: "v1", slug: "weather" },
    });
    // An update stays on the module's own page.
    expect(navigate).not.toHaveBeenCalled();
  });

  it("puts a taken identifier on the field when a rename collides", async () => {
    const user = userEvent.setup();
    vi.mocked(saveCustomTool).mockRejectedValueOnce(
      new Response("The slug taken_name is already in use.", { status: 409 }),
    );
    renderEditor(detail());
    const slug = screen.getByLabelText("Identifier");
    fireEvent.change(slug, { target: { value: "taken_name" } });
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(slug).toHaveAttribute("aria-invalid", "true"));
    expect(screen.getByText("That identifier is taken.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    fireEvent.change(slug, { target: { value: "free_name" } });
    expect(slug).not.toHaveAttribute("aria-invalid");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("runs the test panel and renders output and logs", async () => {
    const user = userEvent.setup();
    vi.mocked(testCustomTool).mockResolvedValue({
      ok: true,
      output: "You said: hi",
      durationMs: 12,
      logs: ["starting"],
      files: [],
    } as never);
    renderEditor(detail());
    await user.click(screen.getByRole("button", { name: "Debug" }));
    const dialog = await screen.findByRole("dialog", { name: "Debug" });
    // The trigger shows the function's label, not its key, before ever opening.
    expect(within(dialog).getByRole("combobox", { name: "Function" })).toHaveTextContent(
      "Current weather",
    );
    // The arguments box starts as a skeleton of the schema, hints in place.
    expect(within(dialog).getByLabelText("Arguments")).toHaveValue(
      JSON.stringify({ city: "City name" }, null, 2),
    );
    await user.click(within(dialog).getByRole("button", { name: "Show schema" }));
    expect(within(dialog).getByLabelText("Parameter schema")).toHaveTextContent('"required"');
    // userEvent types `{}` as key descriptors; paste the JSON instead.
    fireEvent.change(within(dialog).getByLabelText("Arguments"), {
      target: { value: '{"text": "hi"}' },
    });
    await user.click(within(dialog).getByRole("button", { name: "Run" }));

    await waitFor(() =>
      expect(testCustomTool).toHaveBeenCalledWith({
        data: expect.objectContaining({ argumentsJson: '{"text": "hi"}' }),
      }),
    );
    expect(await within(dialog).findByText("You said: hi")).toBeInTheDocument();
    expect(within(dialog).getByText("starting")).toBeInTheDocument();
  });

  it("bypasses the dirty leave guard only after deleting a stored module", async () => {
    const user = userEvent.setup();
    let finishDelete!: () => void;
    vi.mocked(deleteCustomTool).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishDelete = resolve;
      }) as never,
    );
    renderEditor(detail());
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unsaved module" } });
    expect(blocker.current?.enableBeforeUnload).toBe(true);
    await user.click(screen.getByRole("button", { name: "Module actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete module" }));
    await waitFor(() => expect(deleteCustomTool).toHaveBeenCalledWith({ data: { toolId: "t1" } }));
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => finishDelete());
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/admin/custom-tools", ignoreBlocker: true }),
    );
  });

  it("keeps unsaved module edits guarded after a failed deletion", async () => {
    const user = userEvent.setup();
    let failDelete!: (error: Error) => void;
    vi.mocked(deleteCustomTool).mockReturnValueOnce(
      new Promise<void>((_, reject) => {
        failDelete = reject;
      }) as never,
    );
    renderEditor(detail());
    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "Unsaved module" } });
    await user.click(screen.getByRole("button", { name: "Module actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete module" }));
    await waitFor(() => expect(deleteCustomTool).toHaveBeenCalledOnce());
    await act(async () => failDelete(new Error("Offline")));

    expect(toast.error).toHaveBeenCalledWith("Could not delete the module.", {
      description: "Offline.",
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(name).toHaveValue("Unsaved module");
    expect(blocker.current?.enableBeforeUnload).toBe(true);
    confirm.mockResolvedValueOnce(false);
    expect(await blocker.current!.shouldBlockFn()).toBe(true);
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Discard unsaved changes?" }),
    );
  });

  it("toggles from the header switch and deletes from the menu", async () => {
    const user = userEvent.setup();
    vi.mocked(setCustomToolEnabled).mockRejectedValue(new Error("boom"));
    vi.mocked(deleteCustomTool).mockResolvedValue(undefined as never);
    renderEditor(detail());

    await user.click(screen.getByRole("switch", { name: "Enabled" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not update the module.", {
        description: "Boom.",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Module actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete module" }));
    await waitFor(() => expect(deleteCustomTool).toHaveBeenCalledWith({ data: { toolId: "t1" } }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/admin/custom-tools", ignoreBlocker: true }),
    );
  });
});
