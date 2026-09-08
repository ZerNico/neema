import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "~/ui/primitives/dialog";
import { FileValidationIcon } from "@hugeicons/core-free-icons";
import { useMutation, useSuspenseQuery, queryOptions } from "@tanstack/react-query";
import { Schema } from "effect";
import { useState } from "react";
import { toast } from "sonner";
import {
  configureEmbeddings,
  disableEmbeddings,
  getEmbeddingConfiguration,
  rebuildAllKnowledgeIndexes,
} from "../server/functions.ts";
import {
  getDocumentParserTool,
  updateDocumentParserTool,
} from "~/modules/tools/server/functions.ts";
import {
  NumberField,
  integerBetween,
  useInvalidateTools,
} from "~/modules/tools/ui/tool-fields.tsx";
import { ModelSelect } from "~/modules/providers/ui/model-select.tsx";
import { useConfirm } from "~/ui/confirm.tsx";
import { useAppForm } from "~/ui/form/app-form.tsx";
import { EmptyState, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Field, FieldDescription, FieldLabel } from "~/ui/primitives/field";
import { Spinner } from "~/ui/primitives/spinner";
import { Switch } from "~/ui/primitives/switch";

export const embeddingConfigurationQuery = queryOptions({
  queryKey: ["admin", "tools", "embeddings"],
  queryFn: () => getEmbeddingConfiguration(),
});

// Everything an admin decides about how documents become searchable: how text
// is extracted from files, and whether (and through which model) it is
// embedded. Both feed knowledge collections; neither is a chat tool, which is
// why they live here rather than under Tools.
export function KnowledgeAdminPage() {
  return (
    <Page
      title="Documents"
      description="How uploaded documents are read and made searchable for knowledge collections."
    >
      <SemanticSearchSection />
      <DocumentParserSection />
    </Page>
  );
}

function SemanticSearchSection() {
  const { data } = useSuspenseQuery(embeddingConfigurationQuery);
  const confirm = useConfirm();
  const invalidate = useInvalidateTools("knowledge");
  const current = data.config;
  const [compatibilityOpen, setCompatibilityOpen] = useState(false);
  const [modelId, setModelId] = useState<string | null>(current.embeddingModelId);
  const selected = data.models.find((model) => model.id === modelId) ?? null;
  const dimensions = selected?.dimensions ?? null;
  const changed =
    modelId !== current.embeddingModelId || !data.enabled || data.status === "needs_approval";
  const providerLabel = selected ? `${selected.displayName} · ${selected.providerName}` : null;

  const apply = useMutation({
    mutationFn: (decision: "keep" | "rebuild") =>
      configureEmbeddings({
        data: {
          modelId: modelId!,
          dimensions: dimensions!,
          decision,
          expectedRevision: current.connectionRevision,
        },
      }),
    onSuccess: async () => {
      await invalidate();
      toast.success("Semantic search configured. Use Rebuild all to index existing collections.");
    },
    onError: (error) =>
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : "Could not save the configuration.",
      ),
  });
  const disable = useMutation({
    mutationFn: () => disableEmbeddings({ data: { expectedRevision: current.connectionRevision } }),
    onSuccess: invalidate,
    onError: () => toast.error("Could not disable semantic search."),
  });
  const rebuildAll = useMutation({
    mutationFn: () => rebuildAllKnowledgeIndexes(),
    onSuccess: async ({ collections, reextracted, reembedded }) => {
      await invalidate();
      const total = reextracted + reembedded;
      toast.success(
        total === 0
          ? "Every collection is already indexed for the current model."
          : `Rebuilding ${total} documents across ${collections} collections in the background.`,
      );
    },
    onError: (error) =>
      toast.error(
        error instanceof Error && error.message ? error.message : "Could not start the rebuild.",
      ),
  });
  const pending = apply.isPending || disable.isPending || rebuildAll.isPending;

  const save = async () => {
    if (!selected || !dimensions) return;
    // A first configuration, or one with no existing space, has nothing to keep.
    if (!current.spaceId || !current.approvedConnection) {
      const ok = await confirm({
        destructive: false,
        title: "Enable semantic search?",
        description: `Document text from every collection that gets indexed will be sent to ${providerLabel} to compute embeddings. Existing collections are not indexed until their owners rebuild them.`,
        confirmLabel: "Enable",
      });
      if (ok) apply.mutate("rebuild");
      return;
    }
    if (current.dimensions !== dimensions) {
      const ok = await confirm({
        destructive: false,
        title: "Rebuild embeddings?",
        description: `${providerLabel} produces ${dimensions}-dimensional vectors; the current index holds ${current.dimensions}. Existing embeddings cannot be reused and stay excluded until each collection is rebuilt. Keyword search keeps working.`,
        confirmLabel: "Rebuild",
      });
      if (ok) apply.mutate("rebuild");
      return;
    }
    // Same dimensions: the admin decides whether the vectors are comparable.
    // "Keep" is a claim about the models, so it is asked for explicitly.
    setCompatibilityOpen(true);
  };

  return (
    <Section title="Semantic search">
      <Dialog open={compatibilityOpen} onOpenChange={setCompatibilityOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Are the existing embeddings compatible?</DialogTitle>
            <DialogDescription>
              Keep them only if {providerLabel} produces vectors comparable to the previous model.
              Rebuild approves a fresh vector space; existing collections are not submitted until
              you explicitly rebuild their indexes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              variant="outline"
              onClick={() => {
                setCompatibilityOpen(false);
                apply.mutate("rebuild");
              }}
            >
              Rebuild instead
            </Button>
            <Button
              onClick={() => {
                setCompatibilityOpen(false);
                apply.mutate("keep");
              }}
            >
              Keep existing embeddings
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">Knowledge embeddings</span>
            <span className="text-muted-foreground text-xs">
              Lets knowledge search find paraphrases, not just matching words. Keyword search works
              without it. Enabling sends document text to the chosen provider.
            </span>
          </div>
          <Badge variant={data.status === "ready" ? "secondary" : "outline"}>
            {data.status === "ready"
              ? "Ready"
              : data.status === "needs_approval"
                ? "Needs approval"
                : "Off"}
          </Badge>
        </ListRow>
        {data.status === "needs_approval" ? (
          <ListRow>
            <p className="text-warning text-xs">
              The approved model or provider was edited. Confirm the configuration again before
              semantic search resumes; keyword search is unaffected.
            </p>
          </ListRow>
        ) : null}
        <ListRow className="flex-col items-stretch gap-3">
          <Field>
            <FieldLabel htmlFor="embedding-model">Embedding model</FieldLabel>
            <ModelSelect
              id="embedding-model"
              aria-label="Embedding model"
              models={data.models.map((model) => ({
                id: model.id,
                displayName: model.displayName,
                providerName: model.providerName,
                detail: model.dimensions ? `${model.dimensions}d` : null,
              }))}
              value={modelId}
              onChange={setModelId}
              disabled={pending}
              emptyPlaceholder="Add a public embedding model to a provider first"
            />
            <FieldDescription>
              Only enabled models of type Embedding that every user may use are listed.
              Group-restricted models cannot become an instance-wide service.
            </FieldDescription>
          </Field>
          {selected && !selected.dimensions ? (
            <p className="text-warning text-xs" role="alert">
              Set the model&apos;s dimensions on its provider page before enabling it.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={pending || !selected || !dimensions || !changed}
              aria-busy={apply.isPending || undefined}
              onClick={() => void save()}
            >
              {apply.isPending ? <Spinner data-icon="inline-start" aria-hidden /> : null}
              {data.enabled ? "Apply" : "Enable"}
            </Button>
            {data.status === "ready" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                aria-busy={rebuildAll.isPending || undefined}
                onClick={() => {
                  void confirm({
                    destructive: false,
                    title: "Rebuild every collection's index?",
                    description:
                      "Every document not yet indexed for the current model is re-embedded, across all users' collections. Text is sent to the configured provider and billed. Documents that are already current are skipped, and keyword search keeps working throughout.",
                    confirmLabel: "Rebuild all",
                  }).then((ok) => {
                    if (ok) rebuildAll.mutate();
                  });
                }}
              >
                {rebuildAll.isPending ? <Spinner data-icon="inline-start" aria-hidden /> : null}
                Rebuild all
              </Button>
            ) : null}
            {data.enabled ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => {
                  void confirm({
                    destructive: false,
                    title: "Disable semantic search?",
                    description:
                      "Knowledge search falls back to keywords. Existing embeddings are kept and can be re-enabled later.",
                    confirmLabel: "Disable",
                  }).then((ok) => {
                    if (ok) disable.mutate();
                  });
                }}
              >
                Disable
              </Button>
            ) : null}
          </div>
        </ListRow>
      </ListCard>
    </Section>
  );
}

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

export const DocumentParserForm = Schema.Struct({
  maxChars: integerBetween(1000, 500_000),
  maxPages: integerBetween(1, 2000),
});
export const documentParserToolQuery = queryOptions({
  queryKey: ["admin", "tools", "document-parser"],
  queryFn: () => getDocumentParserTool(),
});
