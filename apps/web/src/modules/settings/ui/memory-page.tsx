import {
  Brain02Icon,
  Delete02Icon,
  PencilEdit02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Schema } from "effect";
import { useState } from "react";
import { toast } from "sonner";
import { memoriesQuery, memorySettingsQuery } from "~/modules/memory/client/queries.ts";
import {
  clearMemories,
  createMemory,
  deleteMemory,
  updateMemory,
  updateMemorySettings,
} from "~/modules/memory/server/functions.ts";
import {
  MAX_MEMORIES_PER_USER,
  MAX_MEMORY_CONTENT_LENGTH,
  type Memory,
  type MemoryWriteOutcome,
  type UpdateMemorySettingsInput,
} from "~/modules/memory/schema.ts";
import { absoluteLabel, relativeAgeLabel } from "~/modules/chat/ui/timestamps.ts";
import { useConfirm } from "~/ui/confirm-context.ts";
import { useAppForm } from "~/ui/form/app-form.ts";
import { EmptyState, ErrorState, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Switch } from "~/ui/primitives/switch";
import { toastError } from "~/ui/error-toast.ts";
import { m } from "~/paraglide/messages.js";

// A function, so the messages read in the locale of the page that shows them.
const memoryFormSchema = () =>
  Schema.Struct({
    content: Schema.String.check(
      Schema.isMinLength(1, { message: m.settings_memory_error_empty() }),
      Schema.isMaxLength(MAX_MEMORY_CONTENT_LENGTH, {
        message: m.settings_memory_error_too_long({ max: MAX_MEMORY_CONTENT_LENGTH }),
      }),
    ),
  });

const rejectionMessage = (outcome: MemoryWriteOutcome): string => {
  switch (outcome.outcome) {
    case "limit_reached":
      return m.settings_memory_error_full();
    case "protected":
      return m.settings_memory_error_protected();
    case "not_found":
      return m.settings_memory_error_not_found();
    case "disabled":
      return m.settings_memory_error_disabled();
    case "source_changed":
      return m.settings_memory_error_source_changed();
    case "rejected":
      return outcome.reason === "sensitive"
        ? m.settings_memory_error_sensitive()
        : outcome.reason === "too_long"
          ? m.settings_memory_error_too_long({ max: MAX_MEMORY_CONTENT_LENGTH })
          : m.settings_memory_error_empty();
    default:
      return m.settings_memory_error_save();
  }
};

export function MemoryPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const settings = useQuery(memorySettingsQuery);
  const memories = useQuery(memoriesQuery);
  const [editing, setEditing] = useState<Memory | "new" | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["memory"] });
  const form = useAppForm({
    defaultValues: { content: editing !== null && editing !== "new" ? editing.content : "" },
    validators: { onSubmit: Schema.toStandardSchemaV1(memoryFormSchema()) },
    onSubmit: async ({ value }) => {
      if (editing === null) return;
      const content = value.content.trim();
      try {
        const outcome =
          editing === "new"
            ? await createMemory({ data: { content } })
            : await updateMemory({ data: { memoryId: editing.id, content } });
        if (
          outcome.outcome === "created" ||
          outcome.outcome === "updated" ||
          outcome.outcome === "duplicate"
        ) {
          if (outcome.outcome === "duplicate") toast.info(m.settings_memory_duplicate());
          await invalidate();
          setEditing(null);
          return;
        }
        toast.error(rejectionMessage(outcome));
      } catch {
        toast.error(m.settings_memory_error_save());
      }
    },
  });
  const openEditor = (memory: Memory | "new") => {
    if (form.state.isSubmitting) return;
    form.reset({ content: memory === "new" ? "" : memory.content });
    setEditing(memory);
  };
  const settingsMutation = useMutation({
    mutationFn: (patch: UpdateMemorySettingsInput) => updateMemorySettings({ data: patch }),
    onSuccess: (next) => {
      queryClient.setQueryData(memorySettingsQuery.queryKey, next);
    },
    onError: (error) => toastError(m.settings_memory_error_settings(), error),
  });
  const remove = useMutation({
    mutationFn: (memoryId: string) => deleteMemory({ data: { memoryId } }),
    onSuccess: invalidate,
    onError: (error) => toastError(m.settings_memory_error_delete(), error),
  });
  const clear = useMutation({
    mutationFn: () => clearMemories(),
    onSuccess: invalidate,
    onError: (error) => toastError(m.settings_memory_error_clear(), error),
  });

  const updateSetting = (key: keyof UpdateMemorySettingsInput, value: boolean) => {
    settingsMutation.mutate({ [key]: value });
  };

  const failed = settings.isError || memories.isError;
  const rows = memories.data ?? [];

  return (
    <Page title={m.settings_section_memory()} rootPath="/settings" rootLabel={m.common_settings()}>
      <Section title={m.settings_memory_controls()}>
        {settings.data ? (
          <ListCard>
            {!settings.data.globalEnabled ? (
              <ListRow>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">{m.settings_memory_paused_title()}</span>
                  <span className="text-muted-foreground text-xs">
                    {m.settings_memory_paused_description()}
                  </span>
                </div>
              </ListRow>
            ) : null}
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">{m.settings_memory_use()}</span>
              </div>
              <Switch
                checked={settings.data.referenceEnabled}
                onCheckedChange={(checked) => updateSetting("referenceEnabled", checked)}
                disabled={settingsMutation.isPending || !settings.data.globalEnabled}
                aria-label={m.settings_memory_use()}
              />
            </ListRow>
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">{m.settings_memory_auto_save()}</span>
              </div>
              <Switch
                checked={settings.data.autoSaveEnabled}
                onCheckedChange={(checked) => updateSetting("autoSaveEnabled", checked)}
                disabled={settingsMutation.isPending || !settings.data.globalEnabled}
                aria-label={m.settings_memory_auto_save()}
              />
            </ListRow>
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">{m.settings_memory_past_chats()}</span>
                <span className="text-muted-foreground text-xs">
                  {m.settings_memory_past_chats_description()}
                </span>
              </div>
              <Switch
                checked={settings.data.pastChatsEnabled}
                onCheckedChange={(checked) => updateSetting("pastChatsEnabled", checked)}
                disabled={settingsMutation.isPending || !settings.data.globalEnabled}
                aria-label={m.settings_memory_past_chats()}
              />
            </ListRow>
          </ListCard>
        ) : null}
      </Section>

      <Section
        title={m.settings_memory_saved()}
        description={m.settings_memory_count({ count: rows.length, max: MAX_MEMORIES_PER_USER })}
        actions={
          <>
            {rows.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={clear.isPending}
                onClick={() => {
                  void confirm({
                    title: m.settings_memory_clear_title(),
                    description: m.settings_memory_clear_description(),
                    confirmLabel: m.settings_memory_clear(),
                  }).then((confirmed) => {
                    if (confirmed) clear.mutate();
                  });
                }}
              >
                {m.settings_memory_clear()}
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={() => openEditor("new")}
              disabled={rows.length >= MAX_MEMORIES_PER_USER}
            >
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
              {m.settings_memory_add()}
            </Button>
          </>
        }
      >
        {failed ? (
          <ErrorState
            title={m.settings_memory_error_load()}
            onRetry={() => {
              void Promise.all([settings.refetch(), memories.refetch()]);
            }}
          />
        ) : settings.data === undefined || memories.data === undefined ? null : rows.length ===
          0 ? (
          <EmptyState
            icon={Brain02Icon}
            title={m.settings_memory_empty_title()}
            description={m.settings_memory_empty_description()}
            action={
              <Button size="sm" onClick={() => openEditor("new")}>
                <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
                {m.settings_memory_add()}
              </Button>
            }
          />
        ) : (
          <ListCard>
            {rows.map((memory) => (
              <MemoryRow
                key={memory.id}
                memory={memory}
                deleting={remove.isPending && remove.variables === memory.id}
                onEdit={() => openEditor(memory)}
                onDelete={() => {
                  void confirm({
                    title: m.settings_memory_delete_title(),
                    description: m.settings_memory_delete_description(),
                    confirmLabel: m.settings_memory_delete(),
                  }).then((confirmed) => {
                    if (confirmed) remove.mutate(memory.id);
                  });
                }}
              />
            ))}
          </ListCard>
        )}
      </Section>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !form.state.isSubmitting) setEditing(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          {editing !== null ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {editing === "new" ? m.settings_memory_add() : m.settings_memory_edit()}
                </DialogTitle>
                <DialogDescription>{m.settings_memory_dialog_description()}</DialogDescription>
              </DialogHeader>
              <form
                className="flex flex-col gap-6"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!form.state.isSubmitting) void form.handleSubmit();
                }}
              >
                <form.AppField name="content">
                  {(field) => (
                    <field.TextareaField
                      label={m.settings_memory_field()}
                      description={m.settings_memory_field_description({
                        max: MAX_MEMORY_CONTENT_LENGTH,
                      })}
                      placeholder={m.settings_memory_field_placeholder()}
                    />
                  )}
                </form.AppField>
                <form.AppForm>
                  <DialogFooter>
                    <form.Subscribe selector={(state) => state.isSubmitting}>
                      {(isSubmitting) => (
                        <DialogClose render={<Button variant="outline" disabled={isSubmitting} />}>
                          {m.common_cancel()}
                        </DialogClose>
                      )}
                    </form.Subscribe>
                    <form.SubmitButton>
                      {editing === "new" ? m.settings_memory_add() : m.common_save_changes()}
                    </form.SubmitButton>
                  </DialogFooter>
                </form.AppForm>
              </form>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </Page>
  );
}

function MemoryRow({
  memory,
  deleting,
  onEdit,
  onDelete,
}: {
  memory: Memory;
  deleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const userEdited = memory.editedAt !== null;
  const badge = userEdited
    ? m.settings_memory_badge_edited()
    : memory.origin === "manual"
      ? m.settings_memory_badge_added()
      : m.settings_memory_badge_saved_in_chat();
  const updated = new Date(memory.updatedAt);

  return (
    <ListRow className="items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed">
          {memory.content}
        </p>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <Badge variant="outline">{badge}</Badge>
          {!Number.isNaN(updated.getTime()) ? (
            <time dateTime={memory.updatedAt} title={absoluteLabel(updated)}>
              {m.settings_memory_updated({ age: relativeAgeLabel(updated) })}
            </time>
          ) : null}
          {memory.sourceMessageEdited ? (
            <span className="text-warning">{m.settings_memory_source_edited()}</span>
          ) : memory.sourceConversationId ? (
            <Link
              to="/chat/$conversationId"
              params={{ conversationId: memory.sourceConversationId }}
              className="min-w-0 wrap-anywhere hover:text-foreground underline underline-offset-3"
            >
              {memory.sourceConversationTitle ?? m.settings_memory_source_chat()}
            </Link>
          ) : memory.origin === "model" ? (
            <span>{m.settings_memory_source_deleted()}</span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onEdit}
          aria-label={m.settings_memory_edit()}
        >
          <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          disabled={deleting}
          aria-label={m.settings_memory_delete()}
        >
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
        </Button>
      </div>
    </ListRow>
  );
}
