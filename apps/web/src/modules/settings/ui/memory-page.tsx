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
} from "~/modules/memory/schema.ts";
import { absoluteLabel, relativeAgeLabel } from "~/modules/chat/ui/timestamps.ts";
import { useConfirm } from "~/ui/confirm.tsx";
import { useAppForm } from "~/ui/form/app-form.tsx";
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

const MemoryFormSchema = Schema.Struct({
  content: Schema.String.check(
    Schema.isMinLength(1, { message: "Enter something to remember." }),
    Schema.isMaxLength(MAX_MEMORY_CONTENT_LENGTH, {
      message: `Keep memories to ${MAX_MEMORY_CONTENT_LENGTH} characters or fewer.`,
    }),
  ),
});

const rejectionMessage = (outcome: MemoryWriteOutcome): string => {
  switch (outcome.outcome) {
    case "limit_reached":
      return `Memory is full. Remove an item before adding another.`;
    case "protected":
      return "This memory can only be changed by you.";
    case "not_found":
      return "That memory no longer exists.";
    case "disabled":
      return "Automatic memory saving is disabled.";
    case "source_changed":
      return "The source message changed before the memory could be saved.";
    case "rejected":
      return outcome.reason === "sensitive"
        ? "That looks like a secret or credential and cannot be stored."
        : outcome.reason === "too_long"
          ? `Keep memories to ${MAX_MEMORY_CONTENT_LENGTH} characters or fewer.`
          : "Enter something to remember.";
    default:
      return "Could not save the memory.";
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
    validators: { onSubmit: Schema.toStandardSchemaV1(MemoryFormSchema) },
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
          if (outcome.outcome === "duplicate") toast.info("That memory is already saved.");
          await invalidate();
          setEditing(null);
          return;
        }
        toast.error(rejectionMessage(outcome));
      } catch {
        toast.error("Could not save the memory.");
      }
    },
  });
  const openEditor = (memory: Memory | "new") => {
    if (form.state.isSubmitting) return;
    form.reset({ content: memory === "new" ? "" : memory.content });
    setEditing(memory);
  };
  const settingsMutation = useMutation({
    mutationFn: (patch: { referenceEnabled?: boolean; autoSaveEnabled?: boolean }) =>
      updateMemorySettings({ data: patch }),
    onSuccess: (next) => {
      queryClient.setQueryData(memorySettingsQuery.queryKey, next);
    },
    onError: (error) => toastError("Could not update memory settings.", error),
  });
  const remove = useMutation({
    mutationFn: (memoryId: string) => deleteMemory({ data: { memoryId } }),
    onSuccess: invalidate,
    onError: (error) => toastError("Could not delete the memory.", error),
  });
  const clear = useMutation({
    mutationFn: () => clearMemories(),
    onSuccess: invalidate,
    onError: (error) => toastError("Could not clear saved memories.", error),
  });

  const updateSetting = (key: "referenceEnabled" | "autoSaveEnabled", value: boolean) => {
    settingsMutation.mutate({ [key]: value });
  };

  const failed = settings.isError || memories.isError;
  const rows = memories.data ?? [];

  return (
    <Page title="Memory" rootPath="/settings" rootLabel="Settings">
      <Section title="Controls">
        {settings.data ? (
          <ListCard>
            {!settings.data.globalEnabled ? (
              <ListRow>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">Memory is paused by an administrator</span>
                  <span className="text-muted-foreground text-xs">
                    Models won’t use or add to your memories for now. You can still add, edit and
                    delete them, and your settings are kept.
                  </span>
                </div>
              </ListRow>
            ) : null}
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">Use saved memories</span>
              </div>
              <Switch
                checked={settings.data.referenceEnabled}
                onCheckedChange={(checked) => updateSetting("referenceEnabled", checked)}
                disabled={settingsMutation.isPending || !settings.data.globalEnabled}
                aria-label="Use saved memories"
              />
            </ListRow>
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">Save memories automatically</span>
              </div>
              <Switch
                checked={settings.data.autoSaveEnabled}
                onCheckedChange={(checked) => updateSetting("autoSaveEnabled", checked)}
                disabled={settingsMutation.isPending || !settings.data.globalEnabled}
                aria-label="Save memories automatically"
              />
            </ListRow>
          </ListCard>
        ) : null}
      </Section>

      <Section
        title="Saved memories"
        description={`${rows.length} of ${MAX_MEMORIES_PER_USER}`}
        actions={
          <>
            {rows.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={clear.isPending}
                onClick={() => {
                  void confirm({
                    title: "Clear all saved memories?",
                    description:
                      "This permanently removes every saved memory. Your memory settings will stay the same.",
                    confirmLabel: "Clear all",
                  }).then((confirmed) => {
                    if (confirmed) clear.mutate();
                  });
                }}
              >
                Clear all
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={() => openEditor("new")}
              disabled={rows.length >= MAX_MEMORIES_PER_USER}
            >
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
              Add memory
            </Button>
          </>
        }
      >
        {failed ? (
          <ErrorState
            title="Could not load memory"
            onRetry={() => {
              void Promise.all([settings.refetch(), memories.refetch()]);
            }}
          />
        ) : settings.data === undefined || memories.data === undefined ? null : rows.length ===
          0 ? (
          <EmptyState
            icon={Brain02Icon}
            title="Nothing saved yet"
            description="Add one yourself, or let them be saved automatically."
            action={
              <Button size="sm" onClick={() => openEditor("new")}>
                <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
                Add memory
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
                    title: "Delete this memory?",
                    description: "This permanently removes it from future conversations.",
                    confirmLabel: "Delete memory",
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
                <DialogTitle>{editing === "new" ? "Add memory" : "Edit memory"}</DialogTitle>
                <DialogDescription>Don’t store passwords or other secrets.</DialogDescription>
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
                      label="Memory"
                      description={`Up to ${MAX_MEMORY_CONTENT_LENGTH} characters.`}
                      placeholder="For example: I prefer concise answers with code examples."
                    />
                  )}
                </form.AppField>
                <form.AppForm>
                  <DialogFooter>
                    <form.Subscribe selector={(state) => state.isSubmitting}>
                      {(isSubmitting) => (
                        <DialogClose render={<Button variant="outline" disabled={isSubmitting} />}>
                          Cancel
                        </DialogClose>
                      )}
                    </form.Subscribe>
                    <form.SubmitButton>
                      {editing === "new" ? "Add memory" : "Save changes"}
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
    ? "Edited by you"
    : memory.origin === "manual"
      ? "Added by you"
      : "Saved in chat";
  const updated = new Date(memory.updatedAt);

  return (
    <ListRow className="items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{memory.content}</p>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <Badge variant="outline">{badge}</Badge>
          {!Number.isNaN(updated.getTime()) ? (
            <time dateTime={memory.updatedAt} title={absoluteLabel(updated)}>
              Updated {relativeAgeLabel(updated)}
            </time>
          ) : null}
          {memory.sourceMessageEdited ? (
            <span className="text-warning">Source message edited</span>
          ) : memory.sourceConversationId ? (
            <Link
              to="/chat/$conversationId"
              params={{ conversationId: memory.sourceConversationId }}
              className="hover:text-foreground underline underline-offset-3"
            >
              {memory.sourceConversationTitle ?? "Source chat"}
            </Link>
          ) : memory.origin === "model" ? (
            <span>Source chat deleted</span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label="Edit memory">
          <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          disabled={deleting}
          aria-label="Delete memory"
        >
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
        </Button>
      </div>
    </ListRow>
  );
}
