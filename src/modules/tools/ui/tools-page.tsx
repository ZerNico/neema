import {
  Brain02Icon,
  FileValidationIcon,
  GlobalSearchIcon,
  Link01Icon,
} from "@hugeicons/core-free-icons";
import { useMutation, useQueryClient, useSuspenseQuery, queryOptions } from "@tanstack/react-query";
import type { AnyFieldApi } from "@tanstack/react-form";
import { Schema } from "effect";
import { useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "~/ui/confirm.tsx";
import { useAppForm } from "~/ui/form/app-form.tsx";
import { EmptyState, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Spinner } from "~/ui/primitives/spinner";
import { Switch } from "~/ui/primitives/switch";
import { cn } from "~/ui/utils";
import { RESEARCH_SEARCH_BUDGET, type WebSearchConfig } from "../schema.ts";
import {
  getDocumentParserTool,
  getMemoryTool,
  getUrlReaderTool,
  getWebSearchTool,
  testSearchConnection,
  updateDocumentParserTool,
  updateMemoryTool,
  updateUrlReaderTool,
  updateWebSearchTool,
} from "../server/functions.ts";

export const memoryToolQuery = queryOptions({
  queryKey: ["admin", "tools", "memory"],
  queryFn: () => getMemoryTool(),
});

export const webSearchToolQuery = queryOptions({
  queryKey: ["admin", "tools", "web-search"],
  queryFn: () => getWebSearchTool(),
});

export const documentParserToolQuery = queryOptions({
  queryKey: ["admin", "tools", "document-parser"],
  queryFn: () => getDocumentParserTool(),
});

export const urlReaderToolQuery = queryOptions({
  queryKey: ["admin", "tools", "url-reader"],
  queryFn: () => getUrlReaderTool(),
});

type TestResult =
  | { ok: true; resultCount: number; latencyMs: number }
  | { ok: false; error: string };

// Number inputs are kept as strings in form state (what the <input> holds);
// the schema parses and range-checks them, so a typo shows as a field error
// instead of silently disabling Save.
const integerBetween = (minimum: number, maximum: number) =>
  Schema.NumberFromString.check(
    Schema.isInt({ message: "Enter a whole number." }),
    Schema.isBetween({ minimum, maximum }, { message: `Between ${minimum} and ${maximum}.` }),
  );

const WebSearchForm = Schema.Struct({
  baseUrl: Schema.String.check(Schema.isMinLength(1, { message: "Enter the base URL." })),
  secret: Schema.String,
  maxResults: integerBetween(1, 20),
  researchMaxSearchQueries: integerBetween(RESEARCH_SEARCH_BUDGET.min, RESEARCH_SEARCH_BUDGET.max),
});

const UrlReaderForm = Schema.Struct({
  perPageCharCap: integerBetween(1000, 20000),
});

const DocumentParserForm = Schema.Struct({
  maxChars: integerBetween(1000, 500_000),
  maxPages: integerBetween(1, 2000),
});

const fieldErrors = (field: AnyFieldApi) =>
  field.state.meta.errors.map((e: unknown) => ({
    message:
      typeof e === "string" ? e : ((e as { message?: string } | undefined)?.message ?? "Invalid"),
  }));

/** Number input with min/max — TextField only covers text-like controls. */
function NumberField({
  field,
  label,
  description,
  min,
  max,
  step,
  className,
}: {
  field: AnyFieldApi;
  label: string;
  description?: string;
  min: number;
  max: number;
  step?: number;
  className?: string;
}) {
  const showError = field.state.meta.errors.length > 0;
  return (
    <Field className={className} data-invalid={showError || undefined}>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <Input
        id={field.name}
        name={field.name}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(e) => field.handleChange(e.target.value)}
        aria-invalid={showError || undefined}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {showError ? <FieldError errors={fieldErrors(field)} /> : null}
    </Field>
  );
}

const useInvalidateTools = (availabilityKey: string) => {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin", "tools"] }),
      queryClient.invalidateQueries({ queryKey: ["tools", availabilityKey, "availability"] }),
    ]);
};

export function ToolsPage() {
  return (
    <Page title="Tools" description="Assistant tools available in chats.">
      <MemorySection />
      <WebSearchSection />
      <UrlReaderSection />
      <DocumentParserSection />
    </Page>
  );
}

function MemorySection() {
  const { data: tool } = useSuspenseQuery(memoryToolQuery);
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateMemoryTool({ data: { enabled } }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "tools"] }),
        queryClient.invalidateQueries({ queryKey: ["memory"] }),
      ]),
    onError: () => toast.error("Could not update memory."),
  });

  if (!tool) {
    return (
      <Section title="Memory">
        <EmptyState
          icon={Brain02Icon}
          title="This tool isn't set up yet."
          description="Memory will appear here once it is available on this instance."
        />
      </Section>
    );
  }

  return (
    <Section title="Memory">
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">Assistant memory</span>
            <span className="text-muted-foreground text-xs">
              Globally allow saved memories to be referenced and tool-capable models to save new
              ones automatically. User preferences and manual memory management remain available
              while this is off.
            </span>
          </div>
          <Switch
            checked={tool.enabled}
            onCheckedChange={(checked) => toggle.mutate(checked)}
            disabled={toggle.isPending}
            aria-label="Memory enabled"
          />
        </ListRow>
      </ListCard>
    </Section>
  );
}

function WebSearchSection() {
  const { data: tool } = useSuspenseQuery(webSearchToolQuery);
  const confirm = useConfirm();
  const invalidate = useInvalidateTools("web-search");
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const config = (tool?.config ?? {}) as Partial<WebSearchConfig>;

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateWebSearchTool({ data: { enabled } }),
    onSuccess: invalidate,
    onError: () => toast.error("Could not update web search."),
  });

  const clearSecret = useMutation({
    mutationFn: () => updateWebSearchTool({ data: { clearSecret: true } }),
    onSuccess: invalidate,
    onError: () => toast.error("Could not clear the secret."),
  });

  const test = useMutation({
    mutationFn: (input: { baseUrl: string; secret: string }) =>
      testSearchConnection({
        data: { baseUrl: input.baseUrl, ...(input.secret ? { secret: input.secret } : {}) },
      }),
    onSuccess: (result) => setTestResult(result),
    onError: () => toast.error("Could not test the connection."),
  });

  const form = useAppForm({
    defaultValues: {
      baseUrl: config.baseUrl ?? "",
      secret: "",
      maxResults: String(config.maxResults ?? 8),
      researchMaxSearchQueries: String(
        config.researchMaxSearchQueries ?? RESEARCH_SEARCH_BUDGET.default,
      ),
    },
    validators: { onSubmit: Schema.toStandardSchemaV1(WebSearchForm) },
    onSubmit: async ({ value }) => {
      try {
        await updateWebSearchTool({
          data: {
            baseUrl: value.baseUrl,
            maxResults: Number(value.maxResults),
            researchMaxSearchQueries: Number(value.researchMaxSearchQueries),
            ...(value.secret ? { secret: value.secret } : {}),
          },
        });
      } catch {
        toast.error("Could not save the web search settings.");
        return;
      }
      form.reset({ ...value, secret: "" });
      await invalidate();
    },
  });

  if (!tool) {
    return (
      <Section title="Web search">
        <EmptyState
          icon={GlobalSearchIcon}
          title="This tool isn't set up yet."
          description="Web search will appear here once it is available on this instance."
        />
      </Section>
    );
  }

  return (
    <Section title="Web search">
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">Web search</span>
            <span className="text-muted-foreground text-xs">
              SearXNG-backed search returning titles and snippets. Models with tool support get a
              search toggle in the composer.
            </span>
          </div>
          <Switch
            checked={tool.enabled}
            onCheckedChange={(checked) => toggle.mutate(checked)}
            disabled={toggle.isPending}
            aria-label="Web search enabled"
          />
        </ListRow>

        <ListRow className="flex-col items-stretch gap-3">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">Backend</span>
            <Badge variant="outline">SearXNG</Badge>
          </div>
          <form
            noValidate
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
          >
            <form.AppField name="baseUrl">
              {(field) => (
                <field.TextField label="Base URL" type="url" placeholder="http://localhost:8081" />
              )}
            </form.AppField>
            <form.Field name="secret">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={field.name}>Bearer secret</FieldLabel>
                  <div className="flex gap-2">
                    <Input
                      id={field.name}
                      name={field.name}
                      type="password"
                      autoComplete="off"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      className="flex-1"
                    />
                    {tool.secretConfigured ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabled={clearSecret.isPending}
                        aria-busy={clearSecret.isPending || undefined}
                        onClick={async () => {
                          const confirmed = await confirm({
                            title: "Clear the stored secret?",
                            description:
                              "Web search will call SearXNG without a bearer token until a new secret is saved.",
                            confirmLabel: "Clear",
                          });
                          if (confirmed) clearSecret.mutate();
                        }}
                      >
                        {clearSecret.isPending ? (
                          <Spinner data-icon="inline-start" aria-hidden />
                        ) : null}
                        Clear
                      </Button>
                    ) : null}
                  </div>
                  <FieldDescription>
                    {tool.secretConfigured
                      ? "A secret is stored. Leave empty to keep it."
                      : "Optional."}
                  </FieldDescription>
                </Field>
              )}
            </form.Field>
            <form.Field
              name="maxResults"
              validators={{ onSubmit: Schema.toStandardSchemaV1(integerBetween(1, 20)) }}
            >
              {(field) => (
                <NumberField
                  field={field}
                  label="Max results per query"
                  min={1}
                  max={20}
                  className="max-w-48"
                />
              )}
            </form.Field>
            <form.Field
              name="researchMaxSearchQueries"
              validators={{
                onSubmit: Schema.toStandardSchemaV1(WebSearchForm.fields.researchMaxSearchQueries),
              }}
            >
              {(field) => (
                <NumberField
                  field={field}
                  label="Search queries per research run"
                  description="Maximum individual queries shared across all research workers, not a target. Applies to newly started research runs only; ordinary chat is unchanged."
                  min={RESEARCH_SEARCH_BUDGET.min}
                  max={RESEARCH_SEARCH_BUDGET.max}
                  step={1}
                />
              )}
            </form.Field>
            {testResult ? (
              <p
                role="status"
                className={cn("text-xs", testResult.ok ? "text-success" : "text-destructive")}
              >
                {testResult.ok
                  ? `Connection ok — ${testResult.resultCount} results in ${testResult.latencyMs}ms.`
                  : `Could not connect: ${testResult.error}`}
              </p>
            ) : null}
            <div className="flex gap-2">
              <form.AppForm>
                <form.SubmitButton size="sm">Save</form.SubmitButton>
              </form.AppForm>
              <form.Subscribe selector={(s) => [s.values.baseUrl, s.values.secret] as const}>
                {([baseUrl, secret]) => (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!baseUrl.trim() || test.isPending}
                    aria-busy={test.isPending || undefined}
                    onClick={() => {
                      setTestResult(null);
                      test.mutate({ baseUrl, secret });
                    }}
                  >
                    {test.isPending ? <Spinner data-icon="inline-start" aria-hidden /> : null}
                    Test connection
                  </Button>
                )}
              </form.Subscribe>
            </div>
          </form>
        </ListRow>
      </ListCard>
    </Section>
  );
}

// Lets the model fetch pages from user messages or search results.
// Fetches go out from this server with SSRF guarding (private addresses and
// redirects to them are refused); the page is extracted to markdown locally.
function UrlReaderSection() {
  const { data: tool } = useSuspenseQuery(urlReaderToolQuery);
  const invalidate = useInvalidateTools("web-search");

  const config = (tool?.config ?? {}) as { perPageCharCap?: number };

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateUrlReaderTool({ data: { enabled } }),
    onSuccess: invalidate,
    onError: () => toast.error("Could not update the URL reader."),
  });

  const form = useAppForm({
    defaultValues: { perPageCharCap: String(config.perPageCharCap ?? 12000) },
    validators: { onSubmit: Schema.toStandardSchemaV1(UrlReaderForm) },
    onSubmit: async ({ value }) => {
      try {
        await updateUrlReaderTool({ data: { perPageCharCap: Number(value.perPageCharCap) } });
      } catch {
        toast.error("Could not save the URL reader settings.");
        return;
      }
      form.reset({ perPageCharCap: value.perPageCharCap });
      await invalidate();
    },
  });

  if (!tool) {
    return (
      <Section title="URL reader">
        <EmptyState
          icon={Link01Icon}
          title="This tool isn't set up yet."
          description="The URL reader will appear here once it is available on this instance."
        />
      </Section>
    );
  }

  return (
    <Section title="URL reader">
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">Read linked pages</span>
            <span className="text-muted-foreground text-xs">
              Lets the model fetch several pages at once from user links or search results and read
              their extracted content. It has no separate composer toggle: it is available alongside
              web search or when the conversation provides a URL. Requests to private and internal
              addresses are refused.
            </span>
          </div>
          <Switch
            checked={tool.enabled}
            onCheckedChange={(checked) => toggle.mutate(checked)}
            disabled={toggle.isPending}
            aria-label="URL reader enabled"
          />
        </ListRow>
        <ListRow className="flex-col items-stretch gap-3">
          <form
            noValidate
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <form.Field
                name="perPageCharCap"
                validators={{ onSubmit: Schema.toStandardSchemaV1(integerBetween(1000, 20000)) }}
              >
                {(field) => (
                  <NumberField
                    field={field}
                    label="Per-page character cap"
                    min={1000}
                    max={20000}
                    step={1000}
                  />
                )}
              </form.Field>
            </div>
            <div className="flex gap-2">
              <form.AppForm>
                <form.SubmitButton size="sm">Save</form.SubmitButton>
              </form.AppForm>
            </div>
          </form>
        </ListRow>
      </ListCard>
    </Section>
  );
}

// Local PDF text extraction, used when a model cannot take a PDF natively.
// Kept local on purpose — the alternative would ship the user's document to a
// third-party parser.
function DocumentParserSection() {
  const { data: tool } = useSuspenseQuery(documentParserToolQuery);
  const invalidate = useInvalidateTools("document-parsing");

  const config = (tool?.config ?? {}) as { maxChars?: number; maxPages?: number };

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateDocumentParserTool({ data: { enabled } }),
    onSuccess: invalidate,
    onError: () => toast.error("Could not update document parsing."),
  });

  const form = useAppForm({
    defaultValues: {
      maxChars: String(config.maxChars ?? 120000),
      maxPages: String(config.maxPages ?? 200),
    },
    validators: { onSubmit: Schema.toStandardSchemaV1(DocumentParserForm) },
    onSubmit: async ({ value }) => {
      try {
        await updateDocumentParserTool({
          data: { maxChars: Number(value.maxChars), maxPages: Number(value.maxPages) },
        });
      } catch {
        toast.error("Could not save the document parsing settings.");
        return;
      }
      form.reset({ maxChars: value.maxChars, maxPages: value.maxPages });
      await invalidate();
    },
  });

  if (!tool) {
    return (
      <Section title="Document parsing">
        <EmptyState
          icon={FileValidationIcon}
          title="This tool isn't set up yet."
          description="Document parsing will appear here once it is available on this instance."
        />
      </Section>
    );
  }

  return (
    <Section title="Document parsing">
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">PDF text extraction</span>
            <span className="text-muted-foreground text-xs">
              Extracts text in-process so PDFs still work on models that cannot read files natively.
              Nothing leaves this server. Scanned PDFs without embedded text are not supported.
            </span>
          </div>
          <Switch
            checked={tool.enabled}
            onCheckedChange={(checked) => toggle.mutate(checked)}
            disabled={toggle.isPending}
            aria-label="Document parsing enabled"
          />
        </ListRow>

        <ListRow className="flex-col items-stretch gap-3">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">Backend</span>
            <Badge variant="outline">{tool.kind === "local" ? "Local (unpdf)" : tool.kind}</Badge>
          </div>
          <form
            noValidate
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <form.Field
                name="maxChars"
                validators={{
                  onSubmit: Schema.toStandardSchemaV1(integerBetween(1000, 500_000)),
                }}
              >
                {(field) => (
                  <NumberField
                    field={field}
                    label="Max characters"
                    min={1000}
                    max={500000}
                    step={1000}
                  />
                )}
              </form.Field>
              <form.Field
                name="maxPages"
                validators={{ onSubmit: Schema.toStandardSchemaV1(integerBetween(1, 2000)) }}
              >
                {(field) => <NumberField field={field} label="Max pages" min={1} max={2000} />}
              </form.Field>
            </div>
            <div className="flex gap-2">
              <form.AppForm>
                <form.SubmitButton size="sm">Save</form.SubmitButton>
              </form.AppForm>
            </div>
          </form>
        </ListRow>
      </ListCard>
    </Section>
  );
}
