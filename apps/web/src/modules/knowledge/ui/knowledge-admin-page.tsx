import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "~/ui/primitives/dialog";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { useState } from "react";
import { toast } from "sonner";
import {
  configureEmbeddings,
  disableEmbeddings,
  rebuildAllKnowledgeIndexes,
} from "../server/functions.ts";
import { updateToolSettings } from "~/modules/tools/server/functions.ts";
import { NumberField } from "~/modules/tools/ui/tool-fields.tsx";
import { useInvalidateTools } from "~/modules/tools/client/use-invalidate-tools.ts";
import { integerBetween } from "~/modules/tools/ui/integer-between.ts";
import { ModelSelect } from "~/modules/providers/ui/model-select.tsx";
import { ScanReadingRow } from "~/modules/pdf/ui/scan-reading-row.tsx";
import { useConfirm } from "~/ui/confirm-context.ts";
import { useAppForm } from "~/ui/form/app-form.ts";
import { FormActions, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { SaveLabel, SaveStatus } from "~/ui/save-status.tsx";
import { useSaveStatus } from "~/ui/use-save-status.ts";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Field, FieldDescription, FieldLabel } from "~/ui/primitives/field";
import { Switch } from "~/ui/primitives/switch";
import { toastError } from "~/ui/error-toast.ts";
import { documentParserToolQuery } from "../../tools/client/queries.ts";
import { embeddingConfigurationQuery } from "../client/queries.ts";

/**
 * Everything an admin decides about how documents become searchable: how text
 * is extracted from files, and whether (and through which model) it is
 * embedded. Both feed knowledge collections; neither is a chat tool, which is
 * why they live here rather than under Tools.
 */
export function KnowledgeAdminPage() {
  return (
    <Page title="Documents">
      <SemanticSearchSection />
      <DocumentParserSection />
    </Page>
  );
}

function SemanticSearchSection() {
  const { data } = useSuspenseQuery(embeddingConfigurationQuery);
  const confirm = useConfirm();
  const invalidate = useInvalidateTools();
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
    onError: (error) => toastError("Could not disable semantic search.", error),
  });
  const rebuildAll = useMutation({
    mutationFn: () => rebuildAllKnowledgeIndexes(),
    onSuccess: async ({ collections, reextracted, reembedded }) => {
      await invalidate();
      const total = reextracted + reembedded;
      toast.success(
        total === 0
          ? "Everything is already prepared."
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
        description: `Document text from collections that get prepared is sent to ${providerLabel}. Existing collections stay as they are until their owners redo them.`,
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
              Finds documents that mean the same thing, not just matching words. Sends their text to
              the model you choose.
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
            <FieldDescription>Only models everyone can use are listed.</FieldDescription>
          </Field>
          {selected && !selected.dimensions ? (
            <p className="text-warning text-xs" role="alert">
              Set the model’s dimensions on its provider page before enabling it.
            </p>
          ) : null}
          <FormActions>
            <PendingButton
              size="sm"
              pending={apply.isPending}
              disabled={pending || !selected || !dimensions || !changed}
              onClick={() => void save()}
            >
              {data.enabled ? "Apply" : "Enable"}
            </PendingButton>
            {data.status === "ready" ? (
              <PendingButton
                variant="outline"
                size="sm"
                pending={rebuildAll.isPending}
                disabled={pending}
                onClick={() => {
                  void confirm({
                    destructive: false,
                    title: "Rebuild every collection’s index?",
                    description:
                      "Documents that need it are prepared again, across everyone's collections. This sends their text to the model and costs money. Search keeps working meanwhile.",
                    confirmLabel: "Rebuild all",
                  }).then((ok) => {
                    if (ok) rebuildAll.mutate();
                  });
                }}
              >
                Rebuild all
              </PendingButton>
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
                      "Search goes back to matching words. Nothing is deleted, so you can turn this on again later.",
                    confirmLabel: "Disable",
                  }).then((ok) => {
                    if (ok) disable.mutate();
                  });
                }}
              >
                Disable
              </Button>
            ) : null}
          </FormActions>
        </ListRow>
      </ListCard>
    </Section>
  );
}

function DocumentParserSection() {
  const { data: tool } = useSuspenseQuery(documentParserToolQuery);
  const invalidate = useInvalidateTools();

  const config = tool.config as { maxChars?: number; maxPages?: number };

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      updateToolSettings({ data: { tool: "document_parser", enabled } }),
    onSuccess: invalidate,
    onError: (error) => toastError("Could not update document parsing.", error),
  });

  const { justSaved, markSaved } = useSaveStatus();
  const form = useAppForm({
    defaultValues: {
      maxChars: String(config.maxChars ?? 120000),
      maxPages: String(config.maxPages ?? 200),
    },
    validators: { onSubmit: Schema.toStandardSchemaV1(DocumentParserForm) },
    onSubmit: async ({ value }) => {
      try {
        await updateToolSettings({
          data: {
            tool: "document_parser",
            maxChars: Number(value.maxChars),
            maxPages: Number(value.maxPages),
          },
        });
      } catch {
        toast.error("Could not save the document parsing settings.");
        return;
      }
      markSaved();
      form.reset({ maxChars: value.maxChars, maxPages: value.maxPages });
      await invalidate();
    },
  });

  return (
    <Section title="Document parsing">
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">PDF text extraction</span>
            <span className="text-muted-foreground text-xs">
              Reads the text of PDFs for models that can’t open them, and for collections.
            </span>
          </div>
          <Switch
            checked={tool.enabled}
            onCheckedChange={(checked) => toggle.mutate(checked)}
            disabled={toggle.isPending}
            aria-label="Document parsing enabled"
          />
        </ListRow>

        <ScanReadingRow disabled={!tool.enabled} />

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
                <form.SubmitButton size="sm">
                  <SaveLabel justSaved={justSaved}>Save</SaveLabel>
                </form.SubmitButton>
              </form.AppForm>
              <SaveStatus justSaved={justSaved} />
            </div>
          </form>
        </ListRow>
      </ListCard>
    </Section>
  );
}

const DocumentParserForm = Schema.Struct({
  maxChars: integerBetween(1000, 500_000),
  maxPages: integerBetween(1, 2000),
});
