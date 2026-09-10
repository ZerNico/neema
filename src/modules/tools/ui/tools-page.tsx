import { NumberField, integerBetween, useInvalidateTools } from "./tool-fields.tsx";
import { Brain02Icon, GlobalSearchIcon, Link01Icon } from "@hugeicons/core-free-icons";
import { useMutation, useQueryClient, useSuspenseQuery, queryOptions } from "@tanstack/react-query";
import { Schema } from "effect";
import { useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "~/ui/confirm.tsx";
import { useAppForm } from "~/ui/form/app-form.tsx";
import { EmptyState, FormActions, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Field, FieldDescription, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Switch } from "~/ui/primitives/switch";
import { cn } from "~/ui/utils";
import { RESEARCH_SEARCH_BUDGET, type WebSearchConfig } from "../schema.ts";
import {
  getMemoryTool,
  getUrlReaderTool,
  getWebSearchTool,
  testSearchConnection,
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

export const urlReaderToolQuery = queryOptions({
  queryKey: ["admin", "tools", "url-reader"],
  queryFn: () => getUrlReaderTool(),
});

type TestResult =
  | { ok: true; resultCount: number; latencyMs: number }
  | { ok: false; error: string };

const WebSearchForm = Schema.Struct({
  baseUrl: Schema.String.check(Schema.isMinLength(1, { message: "Enter the base URL." })),
  secret: Schema.String,
  maxResults: integerBetween(1, 20),
  researchMaxSearchQueries: integerBetween(RESEARCH_SEARCH_BUDGET.min, RESEARCH_SEARCH_BUDGET.max),
});

const UrlReaderForm = Schema.Struct({
  perPageCharCap: integerBetween(1000, 20000),
});

export function ToolsPage() {
  return (
    <Page title="Tools" description="Web tools and memory available in chats.">
      <MemorySection />
      <WebSearchSection />
      <UrlReaderSection />
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
        <EmptyState icon={Brain02Icon} title="This tool isn’t set up yet" />
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
              Globally allow saved memories to be referenced and the model to save new ones
              automatically. User preferences and manual memory management remain available while
              this is off.
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
        <EmptyState icon={GlobalSearchIcon} title="This tool isn’t set up yet" />
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
              SearXNG returns titles and snippets. Every chat model can use web search.
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
                      <PendingButton
                        size="sm"
                        variant="destructive"
                        pending={clearSecret.isPending}
                        onClick={async () => {
                          const confirmed = await confirm({
                            title: "Clear the stored secret?",
                            description:
                              "Web search will connect without a secret until a new one is saved.",
                            confirmLabel: "Clear",
                          });
                          if (confirmed) clearSecret.mutate();
                        }}
                      >
                        Clear
                      </PendingButton>
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
            <FormActions>
              <form.AppForm>
                <form.SubmitButton size="sm">Save</form.SubmitButton>
              </form.AppForm>
              <form.Subscribe selector={(s) => [s.values.baseUrl, s.values.secret] as const}>
                {([baseUrl, secret]) => (
                  <PendingButton
                    size="sm"
                    variant="outline"
                    pending={test.isPending}
                    disabled={!baseUrl.trim()}
                    onClick={() => {
                      setTestResult(null);
                      test.mutate({ baseUrl, secret });
                    }}
                  >
                    Test connection
                  </PendingButton>
                )}
              </form.Subscribe>
            </FormActions>
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
        <EmptyState icon={Link01Icon} title="This tool isn’t set up yet" />
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
            <FormActions>
              <form.AppForm>
                <form.SubmitButton size="sm">Save</form.SubmitButton>
              </form.AppForm>
            </FormActions>
          </form>
        </ListRow>
      </ListCard>
    </Section>
  );
}

// Local PDF text extraction, used when a model cannot take a PDF natively.
// Kept local on purpose — the alternative would ship the user's document to a
// third-party parser.

// Semantic search for knowledge collections. Keyword search always works;
// this adds an embedding model. Two things are deliberately explicit here:
// enabling means document text is sent to that provider, and switching
// models asks whether existing vectors stay comparable — a name or a matching
// dimension count never decides that on its own.
