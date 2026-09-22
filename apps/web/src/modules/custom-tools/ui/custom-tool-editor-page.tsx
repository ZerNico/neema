import { javascript } from "@codemirror/lang-javascript";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  MoreVerticalIcon,
  PlayIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { Schema } from "effect";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { AccessDialog } from "~/modules/sharing/ui/access-dialog.tsx";
import { useConfirm } from "~/ui/confirm.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { cn } from "~/ui/utils";
import { Page, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { Switch } from "~/ui/primitives/switch";
import { Textarea } from "~/ui/primitives/textarea";
import {
  CUSTOM_TOOL_LIMITS,
  CustomToolIdentityInput,
  type CustomToolBuildPreview,
  type CustomToolDependency,
  type CustomToolDetail,
  type CustomToolFunctionManifest,
  type CustomToolTestFile,
  type CustomToolTestResult,
} from "../schema.ts";
import {
  checkCustomTool,
  deleteCustomTool,
  getCustomTool,
  saveCustomTool,
  setCustomToolEnabled,
  testCustomTool,
} from "../server/functions.ts";
import { exampleArguments } from "../schema-example.ts";
import { TEMPLATE_SOURCE } from "../template.ts";
import { attachmentKind } from "~/modules/attachments/constants.ts";
import { AttachmentChip, AttachmentChipRow } from "~/modules/attachments/ui/attachment-chip.tsx";

export const customToolQuery = (toolId: string) =>
  queryOptions({
    queryKey: ["admin", "custom-tools", toolId],
    queryFn: () => settled(getCustomTool({ data: { toolId } })),
  });

// Same surface as the skill editor: app tokens, a bounded pane that scrolls
// its own content, and the text cursor the host stylesheet resets.
const editorTheme = EditorView.theme({
  "&": {
    color: "var(--foreground)",
    backgroundColor: "transparent",
    fontSize: "0.875rem",
    maxHeight: "var(--editor-max-height, min(60vh, 32rem))",
  },
  ".cm-content": {
    fontFamily: "var(--font-mono, monospace)",
    padding: "0.75rem 0",
    minHeight: "16rem",
    caretColor: "var(--foreground)",
    cursor: "text",
  },
  ".cm-scroller": { overflow: "auto", fontFamily: "inherit" },
  ".cm-gutters": {
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    border: "none",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--muted)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--accent)",
  },
  "&.cm-focused": { outline: "none" },
});
// `aria-label` on <CodeMirror> lands on the wrapper; the editable node is the
// one a screen reader focuses.
const editorExtensions = [
  javascript({ typescript: true }),
  lintGutter(),
  EditorView.contentAttributes.of({ "aria-label": "TypeScript source" }),
];

const validateIdentity = Schema.toStandardSchemaV1(CustomToolIdentityInput)["~standard"].validate;

/** First message per identity field, from the same schema the server applies. */
const identityIssues = (input: {
  slug: string;
  name: string;
  description: string;
}): Partial<Record<"slug" | "name" | "description", string>> => {
  const result = validateIdentity(input);
  if (result instanceof Promise || !result.issues) return {};
  const issues: Partial<Record<"slug" | "name" | "description", string>> = {};
  for (const issue of result.issues) {
    const key = issue.path?.[0];
    const field = typeof key === "object" ? key.key : key;
    if ((field === "slug" || field === "name" || field === "description") && !issues[field]) {
      issues[field] = issue.message;
    }
  }
  return issues;
};

/** "Weather tools" becomes "weather_tools": the identifier an admin would type anyway. */
const slugFromName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+|_+$/g, "")
    .slice(0, CUSTOM_TOOL_LIMITS.slug);

/** A failed validator answers with its issue list as JSON; show the messages, not the envelope. */
const validationMessages = (body: string): string | null => {
  try {
    const issues: unknown = JSON.parse(body);
    if (!Array.isArray(issues) || issues.length === 0) return null;
    const messages = issues.flatMap((issue: unknown) =>
      issue && typeof issue === "object" && "message" in issue ? [String(issue.message)] : [],
    );
    return messages.length === issues.length ? messages.join("\n") : null;
  } catch {
    return null;
  }
};

const errorMessage = async (error: unknown): Promise<string> => {
  if (error instanceof Response) {
    const body = await error.text();
    return validationMessages(body) ?? (body || `${error.status}`);
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
};

/** A build refusal, split so the parts a line number belongs to can go to the editor. */
export interface BuildProblem {
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

const tscLine = /^(?:.*[\\/])?tool\.ts\((\d+),(\d+)\): (?:error|warning) (TS\d+: .*)$/;

/**
 * The server returns one text blob: a headline plus, for a type check, one
 * `tool.ts(line,col): error TSxxxx: …` per problem, each possibly followed
 * by indented continuation lines. Everything else is a single problem.
 */
export const parseBuildProblems = (text: string): ReadonlyArray<BuildProblem> => {
  const problems: BuildProblem[] = [];
  // Index of the problem that indented continuation lines belong to.
  let open = -1;
  for (const raw of text.split("\n")) {
    const match = tscLine.exec(raw);
    if (match) {
      open =
        problems.push({ message: match[3]!, line: Number(match[1]), column: Number(match[2]) }) - 1;
    } else if (open >= 0 && /^\s+\S/.test(raw)) {
      const last = problems[open]!;
      problems[open] = { ...last, message: `${last.message}\n${raw.trim()}` };
    } else if (raw.trim() && !/^TypeScript check failed:?$/.test(raw.trim())) {
      open = -1;
      problems.push({ message: raw.trim() });
    }
  }
  return problems.length
    ? problems
    : [{ message: text.trim() || "The module could not be built." }];
};

/**
 * A refused server function can arrive as the Response it threw rather than
 * as a rejection (see skill-import-page.tsx), so the value is not a result
 * until it is one.
 */
const settled = async <T,>(call: Promise<T>): Promise<T> => {
  const result = await call;
  if (result instanceof Response) throw new Error(await errorMessage(result));
  return result;
};

const invalidateLists = (queryClient: ReturnType<typeof useQueryClient>) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ["admin", "custom-tools"] }),
    queryClient.invalidateQueries({ queryKey: ["custom-tools", "usable"] }),
  ]);

/** `/admin/custom-tools/new` renders this without a tool; `$toolId` with one. */
export function CustomToolEditorPage({ toolId }: { toolId?: string }) {
  if (toolId === undefined) return <ToolEditor key="new" />;
  return <ExistingToolEditor toolId={toolId} />;
}

function ExistingToolEditor({ toolId }: { toolId: string }) {
  const { data: tool } = useSuspenseQuery(customToolQuery(toolId));
  // Keyed by version: a save replaces the row, and the editor restarts from
  // it rather than reconciling field by field.
  return <ToolEditor key={`${tool.id}:${tool.version}`} tool={tool} />;
}

function ToolEditor({ tool }: { tool?: CustomToolDetail }) {
  const id = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [sharing, setSharing] = useState(false);

  const [name, setName] = useState(tool?.name ?? "");
  const [nameTouched, setNameTouched] = useState(false);
  // The slug follows the name until the admin edits it directly.
  const [slugEdit, setSlugEdit] = useState<string | null>(tool?.slug ?? null);
  const slug = slugEdit ?? slugFromName(name);
  const [description, setDescription] = useState(tool?.description ?? "");
  const identity = identityIssues({ slug, name, description });
  // The server's answer to a Create with a taken identifier, shown on the
  // field until the identifier changes.
  const [slugTaken, setSlugTaken] = useState<string | null>(null);
  const slugError = identity.slug ?? (slugTaken === slug ? "That identifier is taken." : null);
  const [source, setSource] = useState(tool?.source ?? TEMPLATE_SOURCE);
  const [dependencies, setDependencies] = useState<CustomToolDependency[]>(
    tool ? [...tool.dependencies] : [],
  );
  const [preview, setPreview] = useState<CustomToolBuildPreview | null>(
    tool ? { functions: tool.functions } : null,
  );
  const [functionKey, setFunctionKey] = useState(tool?.functions[0]?.key ?? "");
  // Arguments start as a skeleton of the chosen function's schema and stay
  // whatever the admin typed once they touch them; picking a function again
  // starts over.
  const [testArgs, setTestArgs] = useState<string | null>(null);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [testOutcome, setTestOutcome] = useState<CustomToolTestResult | null>(null);
  /** `null` until the next Check; `[]` is a clean build. */
  const [problems, setProblems] = useState<ReadonlyArray<BuildProblem> | null>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);

  // Line-bearing problems become editor diagnostics; the rest stay in the list.
  useEffect(() => {
    if (!view) return;
    const diagnostics: Diagnostic[] = [];
    for (const problem of problems ?? []) {
      if (!problem.line || problem.line > view.state.doc.lines) continue;
      const line = view.state.doc.line(problem.line);
      const from = Math.min(line.from + Math.max(0, (problem.column ?? 1) - 1), line.to);
      diagnostics.push({ from, to: line.to, severity: "error", message: problem.message });
    }
    view.dispatch(setDiagnostics(view.state, diagnostics));
  }, [view, problems]);

  const invalidatePreview = () => {
    setPreview(null);
    setFunctionKey("");
    setTestOutcome(null);
    setProblems(null);
  };
  const updateDependency = (index: number, patch: Partial<CustomToolDependency>) => {
    setDependencies((current) =>
      current.map((dependency, position) =>
        position === index ? { ...dependency, ...patch } : dependency,
      ),
    );
    invalidatePreview();
  };

  const check = useMutation({
    mutationFn: () => settled(checkCustomTool({ data: { slug, source, dependencies } })),
    onSuccess: (result) => {
      setPreview(result);
      setFunctionKey(result.functions[0]?.key ?? "");
      setTestOutcome(null);
      setProblems([]);
    },
    onError: async (error) => setProblems(parseBuildProblems(await errorMessage(error))),
  });
  const save = useMutation({
    mutationFn: () => {
      setSlugTaken(null);
      const shared = { name, description, source, dependencies };
      return settled(
        saveCustomTool({
          data: tool
            ? { toolId: tool.id, expectedVersion: tool.version, slug, ...shared }
            : { slug, ...shared },
        }),
      );
    },
    onSuccess: async (saved) => {
      await invalidateLists(queryClient);
      toast.success(tool ? "Module saved." : "Module created.");
      if (!tool)
        await navigate({ to: "/admin/custom-tools/$toolId", params: { toolId: saved.id } });
    },
    onError: async (error) => {
      const message = await errorMessage(error);
      // Two refusals have a place of their own; a build refusal on Save lands
      // where Check would have put it.
      if (/already in use/i.test(message)) setSlugTaken(slug);
      else if (/changed elsewhere/i.test(message))
        toast.error("This module changed elsewhere. Reload it before saving.");
      else setProblems(parseBuildProblems(message));
    },
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      settled(setCustomToolEnabled({ data: { toolId: tool!.id, enabled } })),
    onSuccess: async () => {
      await invalidateLists(queryClient);
      await queryClient.invalidateQueries({ queryKey: ["admin", "custom-tools", tool!.id] });
    },
    onError: () => toast.error("Could not update the module."),
  });
  const remove = useMutation({
    mutationFn: () => settled(deleteCustomTool({ data: { toolId: tool!.id } })),
    onSuccess: async () => {
      await invalidateLists(queryClient);
      await navigate({ to: "/admin/custom-tools" });
    },
    onError: () => toast.error("Could not delete the module."),
  });
  const test = useMutation({
    mutationFn: async (): Promise<CustomToolTestResult> => {
      try {
        return await settled(
          testCustomTool({
            data: { slug, source, dependencies, functionKey, argumentsJson: argumentsText },
          }),
        );
      } catch (error) {
        return {
          ok: false,
          output: await errorMessage(error),
          durationMs: 0,
          logs: [],
          files: [],
        };
      }
    },
    onSuccess: setTestOutcome,
  });

  const canSave = Object.keys(identity).length === 0 && slugTaken !== slug;
  // A stored module is dirty when any saved field differs; a new one, once
  // anything has been typed beyond the template.
  const dirty = tool
    ? slug !== tool.slug ||
      name !== tool.name ||
      description !== tool.description ||
      source !== tool.source ||
      JSON.stringify(dependencies) !== JSON.stringify(tool.dependencies)
    : name !== "" || description !== "" || source !== TEMPLATE_SOURCE || dependencies.length > 0;
  useBlocker({
    shouldBlockFn: async () =>
      dirty &&
      !save.isSuccess &&
      !(await confirm({
        title: "Discard unsaved changes?",
        description: "Your module has not been saved.",
        confirmLabel: "Discard changes",
      })),
    enableBeforeUnload: dirty && !save.isSuccess,
  });
  const selectedFunction = preview?.functions.find((fn) => fn.key === functionKey) ?? null;
  const argumentsText =
    testArgs ?? (selectedFunction ? exampleArguments(selectedFunction.parametersSchema) : "{}");

  return (
    <Page
      title={tool ? tool.name : "New module"}
      backTo="/admin/custom-tools"
      backLabel="Custom tools"
      actions={
        <>
          {dirty && !save.isSuccess ? (
            <span className="text-muted-foreground text-xs">Unsaved changes</span>
          ) : null}
          {tool ? (
            <Button size="sm" variant="outline" onClick={() => setSharing(true)}>
              <HugeiconsIcon icon={UserGroupIcon} strokeWidth={2} data-icon="inline-start" />
              Access
            </Button>
          ) : null}
          {tool ? (
            <>
              {/* oxlint-disable-next-line shadcn/no-restyle -- an inline toggle in the page header, not a stacked form row */}
              <Field orientation="horizontal" className="w-auto gap-2">
                <FieldLabel
                  htmlFor={`${id}-enabled`}
                  className="text-muted-foreground max-sm:sr-only"
                >
                  Enabled
                </FieldLabel>
                <Switch
                  id={`${id}-enabled`}
                  checked={tool.enabled}
                  disabled={toggle.isPending}
                  onCheckedChange={(checked) => toggle.mutate(checked)}
                />
              </Field>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button variant="ghost" size="icon-sm" aria-label="Module actions" />}
                >
                  <HugeiconsIcon icon={MoreVerticalIcon} strokeWidth={2} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={async () => {
                      if (
                        await confirm({
                          title: `Delete “${tool.name}”?`,
                          description:
                            "Agents lose the module from future attempts; earlier answers keep their tool rows.",
                          confirmLabel: "Delete module",
                        })
                      ) {
                        remove.mutate();
                      }
                    }}
                  >
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                    Delete module
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : null}
          <PendingButton
            size="sm"
            pending={save.isPending}
            onClick={() => save.mutate()}
            disabled={!canSave}
          >
            {tool ? "Save" : "Create"}
          </PendingButton>
        </>
      }
    >
      <Section title="Module">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={(nameTouched && identity.name) || undefined}>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input
              id={`${id}-name`}
              value={name}
              onBlur={() => setNameTouched(true)}
              onChange={(event) => {
                setName(event.target.value);
                if (slugEdit === null) invalidatePreview();
              }}
              placeholder="Weather tools"
              aria-invalid={(nameTouched && !!identity.name) || undefined}
            />
            {nameTouched && identity.name ? (
              <FieldError errors={[{ message: identity.name }]} />
            ) : (
              <FieldDescription>Shown wherever the module is listed.</FieldDescription>
            )}
          </Field>
          <Field data-invalid={(slug.length > 0 && slugError) || undefined}>
            <FieldLabel htmlFor={`${id}-slug`}>Identifier</FieldLabel>
            <Input
              id={`${id}-slug`}
              value={slug}
              onChange={(event) => {
                setSlugEdit(event.target.value);
                invalidatePreview();
              }}
              placeholder="weather_tools"
              aria-invalid={(slug.length > 0 && !!slugError) || undefined}
            />
            {slug.length > 0 && slugError ? (
              <FieldError errors={[{ message: slugError }]} />
            ) : (
              <FieldDescription>
                {tool
                  ? "Renaming changes the functions offered from the next message on."
                  : "Names the functions for the model."}
              </FieldDescription>
            )}
          </Field>
        </div>
        <Field data-invalid={identity.description || undefined}>
          <FieldLabel htmlFor={`${id}-description`}>Description</FieldLabel>
          <Textarea
            id={`${id}-description`}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What this group of functions is for."
            rows={2}
            aria-invalid={!!identity.description || undefined}
          />
          {identity.description ? (
            <FieldError errors={[{ message: identity.description }]} />
          ) : (
            <FieldDescription>Optional.</FieldDescription>
          )}
        </Field>
      </Section>

      <Section
        title="Dependencies"
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setDependencies((current) => [...current, { name: "", version: "" }]);
              invalidatePreview();
            }}
          >
            Add dependency
          </Button>
        }
      >
        {dependencies.length === 0 ? (
          <p className="text-muted-foreground text-sm">No external packages.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {dependencies.map((dependency, index) => (
              <div key={index} className="grid grid-cols-[1fr_10rem_auto] items-end gap-2">
                <Field>
                  <FieldLabel htmlFor={`${id}-dep-${index}-name`}>Package</FieldLabel>
                  <Input
                    id={`${id}-dep-${index}-name`}
                    value={dependency.name}
                    onChange={(event) => updateDependency(index, { name: event.target.value })}
                    placeholder="ky"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-dep-${index}-version`}>Version</FieldLabel>
                  <Input
                    id={`${id}-dep-${index}-version`}
                    value={dependency.version}
                    onChange={(event) => updateDependency(index, { version: event.target.value })}
                    placeholder="1.10.0"
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDependencies((current) =>
                      current.filter((_, position) => position !== index),
                    );
                    invalidatePreview();
                  }}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}
        <p className="text-muted-foreground text-xs">
          Registry package names with exact versions. Install scripts and native addons are
          unsupported.
        </p>
      </Section>

      <Section
        title="Source"
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDebugOpen(true)}
              disabled={!preview || preview.functions.length === 0}
            >
              <HugeiconsIcon icon={PlayIcon} strokeWidth={2} data-icon="inline-start" />
              Debug
            </Button>
            <PendingButton
              size="sm"
              variant="outline"
              pending={check.isPending}
              onClick={() => check.mutate()}
              disabled={!!identity.slug}
            >
              Verify
            </PendingButton>
          </>
        }
      >
        <div className="border-border overflow-hidden rounded-md border">
          <CodeMirror
            onCreateEditor={setView}
            value={source}
            onChange={(value) => {
              setSource(value);
              invalidatePreview();
            }}
            theme={editorTheme}
            extensions={editorExtensions}
            indentWithTab={false}
            basicSetup={{ lineNumbers: true, foldGutter: false }}
          />
        </div>
        <BuildStatus
          pending={check.isPending}
          problems={problems}
          functions={preview?.functions ?? null}
          onJump={(line) => {
            if (!view) return;
            const target = view.state.doc.line(Math.min(line, view.state.doc.lines));
            view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
            view.focus();
          }}
        />
      </Section>

      {preview && preview.functions.length > 0 ? (
        <Dialog open={debugOpen} onOpenChange={setDebugOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Debug</DialogTitle>
              <DialogDescription>
                Runs the verified build on the server with the arguments below. Files it returns
                preview here and are not stored.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
                <Field>
                  <FieldLabel htmlFor={`${id}-test-function`}>Function</FieldLabel>
                  <Select
                    value={functionKey}
                    onValueChange={(value) => {
                      setFunctionKey(value ?? "");
                      setTestArgs(null);
                      setTestOutcome(null);
                    }}
                    // Base UI renders the trigger from `items`; without it the
                    // raw key shows until the popup has mounted once.
                    items={preview.functions.map((fn) => ({ value: fn.key, label: fn.name }))}
                  >
                    <SelectTrigger id={`${id}-test-function`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {preview.functions.map((fn) => (
                        <SelectItem key={fn.key} value={fn.key}>
                          {fn.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-test-args`}>Arguments</FieldLabel>
                  <Textarea
                    id={`${id}-test-args`}
                    value={argumentsText}
                    onChange={(event) => setTestArgs(event.target.value)}
                    rows={Math.min(12, Math.max(3, argumentsText.split("\n").length))}
                  />
                  <FieldDescription>
                    Pre-filled from the function’s parameters.{" "}
                    <button
                      type="button"
                      className="underline underline-offset-4"
                      onClick={() => setSchemaOpen((open) => !open)}
                    >
                      {schemaOpen ? "Hide schema" : "Show schema"}
                    </button>
                  </FieldDescription>
                </Field>
              </div>
              {schemaOpen && selectedFunction ? (
                <pre
                  aria-label="Parameter schema"
                  className="bg-muted/50 max-h-60 overflow-auto rounded-md p-3 text-xs [overflow-wrap:anywhere]"
                >
                  {JSON.stringify(selectedFunction.parametersSchema, null, 2)}
                </pre>
              ) : null}
              {testOutcome ? (
                <div className="border-border bg-muted/50 rounded-md border p-3" role="status">
                  <p
                    className={cn(
                      "text-xs font-medium",
                      testOutcome.ok ? "text-muted-foreground" : "text-destructive",
                    )}
                  >
                    {testOutcome.ok ? "Completed" : "Failed"} in {testOutcome.durationMs} ms
                  </p>
                  {testOutcome.output ? (
                    <pre className="mt-1 max-h-60 overflow-auto text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">
                      {testOutcome.output}
                    </pre>
                  ) : null}
                  {testOutcome.files.length > 0 ? (
                    <AttachmentChipRow className="mt-2" aria-label="Returned files">
                      {testOutcome.files.map((file) => (
                        <TestFileChip key={`${file.name}:${file.size}`} file={file} />
                      ))}
                    </AttachmentChipRow>
                  ) : null}
                  {testOutcome.logs.length > 0 ? (
                    <pre className="text-muted-foreground mt-2 max-h-40 overflow-auto border-t pt-2 text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">
                      {testOutcome.logs.join("\n")}
                    </pre>
                  ) : null}
                </div>
              ) : null}
            </div>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" disabled={test.isPending} />}>
                Close
              </DialogClose>
              <PendingButton
                pending={test.isPending}
                onClick={() => test.mutate()}
                disabled={!functionKey}
              >
                Run
              </PendingButton>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      {tool ? (
        <AccessDialog
          resource={{ kind: "customTool", id: tool.id }}
          title={tool.name}
          open={sharing}
          onOpenChange={setSharing}
        />
      ) : null}
    </Page>
  );
}

/**
 * A file from Test has no attachment row, so the chip previews a `data:` URL
 * through its own dialog. No `href`: a `data:` tab would run as us, and the
 * dialog's "Open original" link is the same door, so it is replaced with a
 * download.
 */
function TestFileChip({ file }: { file: CustomToolTestFile }) {
  const kind = attachmentKind(file.mediaType);
  const item = { fileName: file.name, size: file.size, kind };
  if (!file.dataUrl)
    return <AttachmentChip item={{ ...item, error: "Too large to preview from Test." }} />;
  return (
    <AttachmentChip
      item={{ ...item, previewUrl: kind === "image" ? file.dataUrl : null }}
      preview={file.dataUrl}
      previewActions={
        <a
          href={file.dataUrl}
          download={file.name}
          className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
        >
          Download
        </a>
      }
    />
  );
}

/**
 * One line under the editor saying where the module stands, with the action
 * beside it. Problems with a line go to the editor as diagnostics and are
 * listed here as jump links; the rest are plain text, wrapped, never a raw
 * blob that widens the page.
 */
function BuildStatus({
  pending,
  problems,
  functions,
  onJump,
}: {
  pending: boolean;
  problems: ReadonlyArray<BuildProblem> | null;
  functions: ReadonlyArray<CustomToolFunctionManifest> | null;
  onJump: (line: number) => void;
}) {
  const failed = problems !== null && problems.length > 0;
  const passed = problems !== null && problems.length === 0 && functions !== null;
  // Nothing to say until Verify has been pressed since the last edit.
  if (!pending && !failed && !passed) return null;
  return (
    <div className="flex flex-col gap-2">
      <p
        role="status"
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm",
          failed ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {pending ? (
          "Verifying…"
        ) : failed ? (
          <>
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-4 shrink-0" />
            {problems.length === 1 ? "1 problem" : `${problems.length} problems`}
          </>
        ) : passed ? (
          <>
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              strokeWidth={2}
              className="text-success size-4 shrink-0"
            />
            {functions.length === 1 ? "1 function:" : `${functions.length} functions:`}
            {functions.map((fn) => (
              <code key={fn.key} className="text-foreground text-xs">
                {fn.modelName}
              </code>
            ))}
          </>
        ) : null}
      </p>
      {failed ? (
        <ul
          role="alert"
          className="border-destructive/40 flex max-h-64 flex-col gap-2 overflow-y-auto rounded-md border p-3 text-xs"
        >
          {problems.map((problem, index) => (
            <li key={index} className="[overflow-wrap:anywhere] whitespace-pre-wrap">
              {problem.line ? (
                <button
                  type="button"
                  className="text-destructive mr-1.5 font-mono underline underline-offset-4"
                  onClick={() => onJump(problem.line!)}
                >
                  {problem.line}:{problem.column ?? 1}
                </button>
              ) : null}
              {problem.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
