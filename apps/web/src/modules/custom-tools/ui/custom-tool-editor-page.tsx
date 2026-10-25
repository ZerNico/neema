import { javascript } from "@codemirror/lang-javascript";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import {
  Download01Icon,
  Alert02Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  PlayIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { Schema } from "effect";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { PreviewAction } from "~/modules/attachments/ui/preview-action.tsx";
import { AccessDialog } from "~/modules/sharing/ui/access-dialog.tsx";
import { useConfirm } from "~/ui/confirm-context.ts";
import { SaveLabel, SaveStatus } from "~/ui/save-status.tsx";
import { useSaveStatus } from "~/ui/use-save-status.ts";
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
  saveCustomTool,
  setCustomToolEnabled,
  testCustomTool,
} from "../server/functions.ts";
import { exampleArguments } from "../schema-example.ts";
import { TEMPLATE_SOURCE } from "../template.ts";
import { attachmentKind, attachmentKindForFileName } from "~/modules/attachments/constants.ts";
import { readBase64 } from "~/modules/attachments/client/read-base64.ts";
import { AttachmentChip, AttachmentChipRow } from "~/modules/attachments/ui/attachment-chip.tsx";
import { toastError } from "~/ui/error-toast.ts";
import { OptionalMark } from "~/ui/form/form-fields.tsx";
import { errorMessage } from "../client/error-message.ts";
import { customToolQuery } from "../client/queries.ts";
import { m } from "~/paraglide/messages.js";
import { getLocale, type Locale, locales } from "~/paraglide/runtime.js";

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
  EditorView.contentAttributes.of({ "aria-label": m.custom_tools_editor_source_label() }),
];

const validateIdentity = Schema.toStandardSchemaV1(CustomToolIdentityInput)["~standard"].validate;

/**
 * One message per failing identity field. The schema the server applies decides
 * which fields fail; the words are the page's, since the schema's are English.
 */
const identityIssues = (input: {
  slug: string;
  name: string;
  description: string;
}): Partial<Record<"slug" | "name" | "description", string>> => {
  const result = validateIdentity(input);
  if (result instanceof Promise || !result.issues) return {};
  const failed = new Set(
    result.issues.map((issue) => {
      const key = issue.path?.[0];
      return typeof key === "object" ? key.key : key;
    }),
  );
  return {
    ...(failed.has("slug")
      ? { slug: m.custom_tools_editor_slug_invalid({ max: CUSTOM_TOOL_LIMITS.slug }) }
      : {}),
    ...(failed.has("name")
      ? {
          name: input.name
            ? m.custom_tools_editor_too_long({ max: CUSTOM_TOOL_LIMITS.name })
            : m.custom_tools_editor_name_required(),
        }
      : {}),
    ...(failed.has("description")
      ? { description: m.custom_tools_editor_too_long({ max: CUSTOM_TOOL_LIMITS.description }) }
      : {}),
  };
};

/** Whether a refusal is this message, in whichever locale the server worded it. */
const isRefusal = (text: string, render: (locale: Locale) => string) =>
  locales.some((locale) => text === render(locale));

/** "Weather tools" becomes "weather_tools": the identifier an admin would type anyway. */
const slugFromName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+|_+$/g, "")
    .slice(0, CUSTOM_TOOL_LIMITS.slug);

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
const parseBuildProblems = (text: string): ReadonlyArray<BuildProblem> => {
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
    : [{ message: text.trim() || m.custom_tools_editor_build_failed() }];
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
  return <ToolEditor key={tool.id} tool={tool} />;
}

function ToolEditor({ tool }: { tool?: CustomToolDetail }) {
  const id = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [sharing, setSharing] = useState(false);
  const { justSaved, markSaved } = useSaveStatus();

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
  const slugError =
    identity.slug ?? (slugTaken === slug ? m.custom_tools_editor_slug_taken() : null);
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
  /** Files a Test run's file parameters may name, like a model names chat files. */
  const [testFiles, setTestFiles] = useState<ReadonlyArray<File>>([]);
  /** `null` until the next Check; `[]` is a clean build. */
  const [problems, setProblems] = useState<ReadonlyArray<BuildProblem> | null>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [saved, setSaved] = useState(() => ({
    slug,
    name,
    description,
    source,
    dependencies,
    version: tool?.version,
  }));
  const [remoteVersion, setRemoteVersion] = useState(tool?.version);
  const buildRevision = useRef(0);
  const buildInputs = useRef({ slug, source, dependencies });
  const [conflict, setConflict] = useState(false);
  const dirty =
    slug !== saved.slug ||
    name !== saved.name ||
    description !== saved.description ||
    source !== saved.source ||
    JSON.stringify(dependencies) !== JSON.stringify(saved.dependencies);

  const adopt = useCallback((next: CustomToolDetail) => {
    setName(next.name);
    setSlugEdit(next.slug);
    setDescription(next.description);
    setSource(next.source);
    setDependencies([...next.dependencies]);
    setSaved({ ...next, dependencies: [...next.dependencies] });
    setPreview({ functions: next.functions });
    setFunctionKey(next.functions[0]?.key ?? "");
    setProblems(null);
    setTestOutcome(null);
    setConflict(false);
  }, []);
  if (tool && tool.version !== remoteVersion) {
    setRemoteVersion(tool.version);
    if (tool.version !== saved.version) {
      if (dirty) setConflict(true);
      else adopt(tool);
    }
  }

  // Remote adoption also invalidates a Verify still awaiting its response.
  useEffect(() => {
    const previous = buildInputs.current;
    if (
      previous.slug !== slug ||
      previous.source !== source ||
      previous.dependencies !== dependencies
    ) {
      buildRevision.current++;
      buildInputs.current = { slug, source, dependencies };
    }
  }, [slug, source, dependencies]);

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
    buildRevision.current++;
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
    mutationFn: (submitted: {
      slug: string;
      source: string;
      dependencies: CustomToolDependency[];
      revision: number;
    }) =>
      checkCustomTool({
        data: {
          slug: submitted.slug,
          source: submitted.source,
          dependencies: submitted.dependencies,
        },
      }),
    onSuccess: (result, submitted) => {
      if (submitted.revision !== buildRevision.current) return;
      setPreview(result);
      setFunctionKey(result.functions[0]?.key ?? "");
      setTestOutcome(null);
      setProblems([]);
    },
    onError: (error, submitted) => {
      const message = errorMessage(error);
      if (submitted.revision === buildRevision.current) setProblems(parseBuildProblems(message));
    },
  });
  const save = useMutation({
    mutationFn: (submitted: typeof saved & { revision: number }) => {
      setSlugTaken(null);
      const { version, revision: _revision, ...input } = submitted;
      return saveCustomTool({
        data: tool ? { toolId: tool.id, expectedVersion: version!, ...input } : input,
      });
    },
    onSuccess: async (accepted, submitted) => {
      const { revision: _revision, ...baseline } = submitted;
      setSaved({ ...baseline, version: accepted.version });
      setConflict(false);
      if (tool) markSaved();
      await invalidateLists(queryClient);
      if (!tool)
        await navigate({
          to: "/admin/custom-tools/$toolId",
          params: { toolId: accepted.id },
          ignoreBlocker: true,
        });
    },
    onError: async (error, submitted) => {
      const message = errorMessage(error);
      if (isRefusal(message, (locale) => m.custom_tools_error_conflict({}, { locale }))) {
        if (tool)
          await queryClient.invalidateQueries({
            queryKey: customToolQuery(tool.id).queryKey,
            exact: true,
          });
        setConflict(true);
        toast.error(m.custom_tools_error_conflict());
      } else if (
        isRefusal(message, (locale) =>
          m.custom_tools_error_slug_taken({ slug: submitted.slug }, { locale }),
        )
      )
        setSlugTaken(submitted.slug);
      else if (submitted.revision === buildRevision.current)
        setProblems(parseBuildProblems(message));
    },
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setCustomToolEnabled({ data: { toolId: tool!.id, enabled } }),
    onSuccess: async () => {
      await invalidateLists(queryClient);
      await queryClient.invalidateQueries({ queryKey: ["admin", "custom-tools", tool!.id] });
    },
    onError: (error) => toastError(m.custom_tools_editor_error_update(), error),
  });
  const remove = useMutation({
    mutationFn: () => deleteCustomTool({ data: { toolId: tool!.id } }),
    onSuccess: async () => {
      await invalidateLists(queryClient);
      await navigate({ to: "/admin/custom-tools", ignoreBlocker: true });
    },
    onError: (error) => toastError(m.custom_tools_editor_error_delete(), error),
  });
  const test = useMutation({
    mutationFn: async (): Promise<CustomToolTestResult> => {
      try {
        return await testCustomTool({
          data: {
            slug,
            source,
            dependencies,
            functionKey,
            argumentsJson: argumentsText,
            ...(testFiles.length
              ? {
                  files: await Promise.all(
                    testFiles.map(async (file) => ({
                      name: file.name,
                      base64: await readBase64(file),
                    })),
                  ),
                }
              : {}),
          },
        });
      } catch (error) {
        return {
          ok: false,
          output: errorMessage(error),
          durationMs: 0,
          logs: [],
          files: [],
        };
      }
    },
    onSuccess: setTestOutcome,
  });

  const canSave = Object.keys(identity).length === 0 && slugTaken !== slug;
  useBlocker({
    shouldBlockFn: async () =>
      dirty &&
      !(await confirm({
        title: m.common_discard_title(),
        description: m.custom_tools_editor_unsaved(),
        confirmLabel: m.common_discard_changes(),
      })),
    enableBeforeUnload: dirty,
  });
  const selectedFunction = preview?.functions.find((fn) => fn.key === functionKey) ?? null;
  const argumentsText =
    testArgs ?? (selectedFunction ? exampleArguments(selectedFunction.parametersSchema) : "{}");

  return (
    <Page
      title={tool ? tool.name : m.custom_tools_editor_new_title()}
      backTo="/admin/custom-tools"
      backLabel={m.custom_tools_editor_back()}
      actions={
        <>
          <SaveStatus justSaved={justSaved} />
          {tool ? (
            <Button size="sm" variant="outline" onClick={() => setSharing(true)}>
              <HugeiconsIcon icon={UserGroupIcon} strokeWidth={2} data-icon="inline-start" />
              {m.custom_tools_editor_access()}
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
                  {m.custom_tools_editor_enabled()}
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
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={m.custom_tools_editor_actions()}
                    />
                  }
                >
                  <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={async () => {
                      if (
                        await confirm({
                          title: m.custom_tools_editor_delete_title({ name: tool.name }),
                          description: m.custom_tools_editor_delete_description(),
                          confirmLabel: m.custom_tools_editor_delete_confirm(),
                        })
                      ) {
                        remove.mutate();
                      }
                    }}
                  >
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                    {m.custom_tools_editor_delete_menu()}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : null}
          <PendingButton
            size="sm"
            pending={save.isPending}
            onClick={() =>
              save.mutate({
                slug,
                name,
                description,
                source,
                dependencies,
                version: saved.version,
                revision: buildRevision.current,
              })
            }
            disabled={!canSave || (!!tool && !dirty)}
          >
            <SaveLabel justSaved={justSaved}>
              {tool ? m.common_save_changes() : m.custom_tools_editor_create()}
            </SaveLabel>
          </PendingButton>
        </>
      }
    >
      {conflict && tool ? (
        <div role="alert" className="flex items-center gap-3">
          <p className="text-muted-foreground text-sm">{m.custom_tools_editor_conflict()}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              if (
                await confirm({
                  title: m.common_discard_title(),
                  description: m.custom_tools_editor_unsaved(),
                  confirmLabel: m.custom_tools_editor_reload(),
                })
              )
                adopt(tool);
            }}
          >
            {m.custom_tools_editor_reload()}
          </Button>
        </div>
      ) : null}
      <Section title={m.custom_tools_editor_module_section()}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={(nameTouched && identity.name) || undefined}>
            <FieldLabel htmlFor={`${id}-name`}>{m.common_name()}</FieldLabel>
            <Input
              id={`${id}-name`}
              value={name}
              onBlur={() => setNameTouched(true)}
              onChange={(event) => {
                setName(event.target.value);
                if (slugEdit === null) invalidatePreview();
              }}
              placeholder={m.custom_tools_editor_name_placeholder()}
              aria-invalid={(nameTouched && !!identity.name) || undefined}
            />
            {nameTouched && identity.name ? (
              <FieldError errors={[{ message: identity.name }]} />
            ) : (
              <FieldDescription>{m.custom_tools_editor_name_description()}</FieldDescription>
            )}
          </Field>
          <Field data-invalid={(slug.length > 0 && slugError) || undefined}>
            <FieldLabel htmlFor={`${id}-slug`}>{m.custom_tools_editor_slug_label()}</FieldLabel>
            <Input
              id={`${id}-slug`}
              value={slug}
              onChange={(event) => {
                setSlugEdit(event.target.value);
                invalidatePreview();
              }}
              // oxlint-disable-next-line i18n/no-literal-text -- an identifier, typed as code
              placeholder="weather_tools"
              aria-invalid={(slug.length > 0 && !!slugError) || undefined}
              aria-describedby={`${id}-slug-description`}
            />
            {slug.length > 0 && slugError ? (
              <FieldError id={`${id}-slug-description`} errors={[{ message: slugError }]} />
            ) : (
              <FieldDescription id={`${id}-slug-description`}>
                {tool
                  ? m.custom_tools_editor_slug_rename_description()
                  : m.custom_tools_editor_slug_description()}
              </FieldDescription>
            )}
          </Field>
        </div>
        <Field data-invalid={identity.description || undefined}>
          <FieldLabel htmlFor={`${id}-description`}>
            {m.common_description()} <OptionalMark />
          </FieldLabel>
          <Textarea
            id={`${id}-description`}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={m.custom_tools_editor_description_placeholder()}
            rows={2}
            aria-invalid={!!identity.description || undefined}
          />
          {identity.description ? (
            <FieldError errors={[{ message: identity.description }]} />
          ) : null}
        </Field>
      </Section>

      <Section
        title={m.custom_tools_editor_dependencies()}
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
            {m.custom_tools_editor_add_dependency()}
          </Button>
        }
      >
        {dependencies.length === 0 ? (
          <p className="text-muted-foreground text-sm">{m.custom_tools_editor_no_dependencies()}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {dependencies.map((dependency, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- rows are controlled inputs holding no state of their own
              <div key={index} className="grid grid-cols-[1fr_10rem_auto] items-end gap-2">
                <Field>
                  <FieldLabel htmlFor={`${id}-dep-${index}-name`}>
                    {m.custom_tools_editor_package()}
                  </FieldLabel>
                  <Input
                    id={`${id}-dep-${index}-name`}
                    value={dependency.name}
                    onChange={(event) => updateDependency(index, { name: event.target.value })}
                    // oxlint-disable-next-line i18n/no-literal-text -- an npm package name
                    placeholder="ky"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-dep-${index}-version`}>
                    {m.custom_tools_editor_version()}
                  </FieldLabel>
                  <Input
                    id={`${id}-dep-${index}-version`}
                    value={dependency.version}
                    onChange={(event) => updateDependency(index, { version: event.target.value })}
                    // oxlint-disable-next-line i18n/no-literal-text -- a version number
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
                  {m.common_remove()}
                </Button>
              </div>
            ))}
          </div>
        )}
        <p className="text-muted-foreground text-xs">{m.custom_tools_editor_dependencies_hint()}</p>
      </Section>

      <Section
        title={m.custom_tools_editor_source_section()}
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDebugOpen(true)}
              disabled={!preview || preview.functions.length === 0}
            >
              <HugeiconsIcon icon={PlayIcon} strokeWidth={2} data-icon="inline-start" />
              {m.custom_tools_editor_debug()}
            </Button>
            <PendingButton
              size="sm"
              variant="outline"
              pending={check.isPending}
              onClick={() =>
                check.mutate({ slug, source, dependencies, revision: buildRevision.current })
              }
              disabled={!!identity.slug}
            >
              {m.custom_tools_editor_verify()}
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
              <DialogTitle>{m.custom_tools_editor_debug_title()}</DialogTitle>
              <DialogDescription>{m.custom_tools_editor_debug_description()}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
                <Field>
                  <FieldLabel htmlFor={`${id}-test-function`}>
                    {m.custom_tools_editor_function()}
                  </FieldLabel>
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
                  <FieldLabel htmlFor={`${id}-test-args`}>
                    {m.custom_tools_editor_arguments()}
                  </FieldLabel>
                  <Textarea
                    id={`${id}-test-args`}
                    value={argumentsText}
                    onChange={(event) => setTestArgs(event.target.value)}
                    rows={Math.min(12, Math.max(3, argumentsText.split("\n").length))}
                  />
                  <FieldDescription>
                    {m.custom_tools_editor_arguments_prefilled()}{" "}
                    <button
                      type="button"
                      className="underline underline-offset-4"
                      onClick={() => setSchemaOpen((open) => !open)}
                    >
                      {schemaOpen
                        ? m.custom_tools_editor_hide_schema()
                        : m.custom_tools_editor_show_schema()}
                    </button>
                  </FieldDescription>
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor={`${id}-test-files`}>
                  {m.custom_tools_editor_files()} <OptionalMark />
                </FieldLabel>
                <Input
                  id={`${id}-test-files`}
                  type="file"
                  multiple
                  onChange={(event) => {
                    const picked = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    setTestFiles((current) =>
                      [
                        ...current.filter(
                          (file) => !picked.some((next) => next.name === file.name),
                        ),
                        ...picked,
                      ].slice(0, CUSTOM_TOOL_LIMITS.inputFiles),
                    );
                  }}
                />
                <FieldDescription>{m.custom_tools_editor_files_hint()}</FieldDescription>
                {testFiles.length > 0 ? (
                  <AttachmentChipRow aria-label={m.custom_tools_editor_test_files()}>
                    {testFiles.map((file) => (
                      <AttachmentChip
                        key={file.name}
                        item={{
                          fileName: file.name,
                          size: file.size,
                          kind: attachmentKindForFileName(file.name),
                        }}
                        onRemove={() =>
                          setTestFiles((current) => current.filter((each) => each !== file))
                        }
                      />
                    ))}
                  </AttachmentChipRow>
                ) : null}
              </Field>
              {schemaOpen && selectedFunction ? (
                <pre
                  aria-label={m.custom_tools_editor_parameter_schema()}
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
                    {(testOutcome.ok
                      ? m.custom_tools_editor_test_completed
                      : m.custom_tools_editor_test_failed)({
                      duration: new Intl.NumberFormat(getLocale()).format(testOutcome.durationMs),
                    })}
                  </p>
                  {testOutcome.output ? (
                    <pre className="mt-1 max-h-60 overflow-auto text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">
                      {testOutcome.output}
                    </pre>
                  ) : null}
                  {testOutcome.files.length > 0 ? (
                    <AttachmentChipRow
                      className="mt-2"
                      aria-label={m.custom_tools_editor_returned_files()}
                    >
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
                {m.common_close()}
              </DialogClose>
              <PendingButton
                pending={test.isPending}
                onClick={() => test.mutate()}
                disabled={!functionKey}
              >
                {m.custom_tools_editor_run()}
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
    return (
      <AttachmentChip item={{ ...item, error: m.custom_tools_editor_test_file_too_large() }} />
    );
  return (
    <AttachmentChip
      item={{ ...item, previewUrl: kind === "image" ? file.dataUrl : null }}
      preview={file.dataUrl}
      previewActions={
        <PreviewAction
          icon={Download01Icon}
          label={m.common_download()}
          href={file.dataUrl}
          download={file.name}
        />
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
          m.custom_tools_editor_verifying()
        ) : failed ? (
          <>
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-4 shrink-0" />
            {m.custom_tools_editor_problem_count({ count: problems.length })}
          </>
        ) : passed ? (
          <>
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              strokeWidth={2}
              className="text-success size-4 shrink-0"
            />
            {m.custom_tools_editor_function_count({ count: functions.length })}
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
            // oxlint-disable-next-line react/no-array-index-key -- the list is rebuilt whole on every build
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
