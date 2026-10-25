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
import { m } from "~/paraglide/messages.js";

/**
 * Everything an admin decides about how documents become searchable: how text
 * is extracted from files, and whether (and through which model) it is
 * embedded. Both feed knowledge collections; neither is a chat tool, which is
 * why they live here rather than under Tools.
 */
export function KnowledgeAdminPage() {
  return (
    <Page title={m.knowledge_admin_title()}>
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
      toast.success(m.knowledge_admin_configured());
    },
    onError: (error) =>
      toast.error(
        error instanceof Error && error.message ? error.message : m.knowledge_admin_save_failed(),
      ),
  });
  const disable = useMutation({
    mutationFn: () => disableEmbeddings({ data: { expectedRevision: current.connectionRevision } }),
    onSuccess: invalidate,
    onError: (error) => toastError(m.knowledge_admin_disable_failed(), error),
  });
  const rebuildAll = useMutation({
    mutationFn: () => rebuildAllKnowledgeIndexes(),
    onSuccess: async ({ collections, reextracted, reembedded }) => {
      await invalidate();
      const total = reextracted + reembedded;
      toast.success(
        total === 0
          ? m.knowledge_admin_all_prepared()
          : m.knowledge_admin_rebuild_started({ count: total, collections }),
      );
    },
    onError: (error) =>
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : m.knowledge_admin_rebuild_failed(),
      ),
  });
  const pending = apply.isPending || disable.isPending || rebuildAll.isPending;

  const save = async () => {
    if (!selected || !dimensions) return;
    // A first configuration, or one with no existing space, has nothing to keep.
    if (!current.spaceId || !current.approvedConnection) {
      const ok = await confirm({
        destructive: false,
        title: m.knowledge_admin_enable_title(),
        description: m.knowledge_admin_enable_description({ provider: providerLabel ?? "" }),
        confirmLabel: m.knowledge_admin_enable(),
      });
      if (ok) apply.mutate("rebuild");
      return;
    }
    if (current.dimensions !== dimensions) {
      const ok = await confirm({
        destructive: false,
        title: m.knowledge_admin_rebuild_embeddings_title(),
        description: m.knowledge_admin_rebuild_embeddings_description({
          provider: providerLabel ?? "",
          dimensions,
          current: current.dimensions ?? 0,
        }),
        confirmLabel: m.knowledge_admin_rebuild(),
      });
      if (ok) apply.mutate("rebuild");
      return;
    }
    // Same dimensions: the admin decides whether the vectors are comparable.
    // "Keep" is a claim about the models, so it is asked for explicitly.
    setCompatibilityOpen(true);
  };

  return (
    <Section title={m.knowledge_admin_semantic_search()}>
      <Dialog open={compatibilityOpen} onOpenChange={setCompatibilityOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{m.knowledge_admin_compatible_title()}</DialogTitle>
            <DialogDescription>
              {m.knowledge_admin_compatible_description({ provider: providerLabel ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>{m.common_cancel()}</DialogClose>
            <Button
              variant="outline"
              onClick={() => {
                setCompatibilityOpen(false);
                apply.mutate("rebuild");
              }}
            >
              {m.knowledge_admin_rebuild_instead()}
            </Button>
            <Button
              onClick={() => {
                setCompatibilityOpen(false);
                apply.mutate("keep");
              }}
            >
              {m.knowledge_admin_keep_embeddings()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">{m.knowledge_admin_embeddings()}</span>
            <span className="text-muted-foreground text-xs">
              {m.knowledge_admin_embeddings_description()}
            </span>
          </div>
          <Badge variant={data.status === "ready" ? "secondary" : "outline"}>
            {data.status === "ready"
              ? m.knowledge_admin_status_ready()
              : data.status === "needs_approval"
                ? m.knowledge_admin_status_needs_approval()
                : m.knowledge_admin_status_off()}
          </Badge>
        </ListRow>
        {data.status === "needs_approval" ? (
          <ListRow>
            <p className="text-warning text-xs">{m.knowledge_admin_needs_approval_hint()}</p>
          </ListRow>
        ) : null}
        <ListRow className="flex-col items-stretch gap-3">
          <Field>
            <FieldLabel htmlFor="embedding-model">{m.knowledge_admin_embedding_model()}</FieldLabel>
            <ModelSelect
              id="embedding-model"
              aria-label={m.knowledge_admin_embedding_model()}
              models={data.models.map((model) => ({
                id: model.id,
                displayName: model.displayName,
                providerName: model.providerName,
                detail: model.dimensions ? `${model.dimensions}d` : null,
              }))}
              value={modelId}
              onChange={setModelId}
              disabled={pending}
              emptyPlaceholder={m.knowledge_admin_embedding_model_empty()}
            />
            <FieldDescription>{m.knowledge_admin_embedding_model_hint()}</FieldDescription>
          </Field>
          {selected && !selected.dimensions ? (
            <p className="text-warning text-xs" role="alert">
              {m.knowledge_admin_dimensions_missing()}
            </p>
          ) : null}
          <FormActions>
            <PendingButton
              size="sm"
              pending={apply.isPending}
              disabled={pending || !selected || !dimensions || !changed}
              onClick={() => void save()}
            >
              {data.enabled ? m.knowledge_admin_apply() : m.knowledge_admin_enable()}
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
                    title: m.knowledge_admin_rebuild_all_title(),
                    description: m.knowledge_admin_rebuild_all_description(),
                    confirmLabel: m.knowledge_admin_rebuild_all(),
                  }).then((ok) => {
                    if (ok) rebuildAll.mutate();
                  });
                }}
              >
                {m.knowledge_admin_rebuild_all()}
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
                    title: m.knowledge_admin_disable_title(),
                    description: m.knowledge_admin_disable_description(),
                    confirmLabel: m.knowledge_admin_disable(),
                  }).then((ok) => {
                    if (ok) disable.mutate();
                  });
                }}
              >
                {m.knowledge_admin_disable()}
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
    onError: (error) => toastError(m.knowledge_admin_parsing_update_failed(), error),
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
        toast.error(m.knowledge_admin_parsing_save_failed());
        return;
      }
      markSaved();
      form.reset({ maxChars: value.maxChars, maxPages: value.maxPages });
      await invalidate();
    },
  });

  return (
    <Section title={m.knowledge_admin_parsing()}>
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">{m.knowledge_admin_pdf_extraction()}</span>
            <span className="text-muted-foreground text-xs">
              {m.knowledge_admin_pdf_extraction_description()}
            </span>
          </div>
          <Switch
            checked={tool.enabled}
            onCheckedChange={(checked) => toggle.mutate(checked)}
            disabled={toggle.isPending}
            aria-label={m.knowledge_admin_parsing_enabled()}
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
                    label={m.knowledge_admin_max_characters()}
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
                {(field) => (
                  <NumberField
                    field={field}
                    label={m.knowledge_admin_max_pages()}
                    min={1}
                    max={2000}
                  />
                )}
              </form.Field>
            </div>
            <div className="flex gap-2">
              <form.AppForm>
                <form.SubmitButton size="sm">
                  <SaveLabel justSaved={justSaved}>{m.common_save()}</SaveLabel>
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
