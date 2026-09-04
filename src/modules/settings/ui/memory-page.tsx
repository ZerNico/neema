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
import { useHydrated } from "~/ui/use-hydrated.ts";

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
  const [dialogPending, setDialogPending] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["memory"] });
  const settingsMutation = useMutation({
    mutationFn: (patch: { referenceEnabled?: boolean; autoSaveEnabled?: boolean }) =>
      updateMemorySettings({ data: patch }),
    onSuccess: (next) => {
      queryClient.setQueryData(memorySettingsQuery.queryKey, next);
    },
    onError: () => toast.error("Could not update memory settings."),
  });
  const remove = useMutation({
    mutationFn: (memoryId: string) => deleteMemory({ data: { memoryId } }),
    onSuccess: invalidate,
    onError: () => toast.error("Could not delete the memory."),
  });
  const clear = useMutation({
    mutationFn: () => clearMemories(),
    onSuccess: invalidate,
    onError: () => toast.error("Could not clear saved memories."),
  });

  const updateSetting = (key: "referenceEnabled" | "autoSaveEnabled", value: boolean) => {
    settingsMutation.mutate({ [key]: value });
  };

  const failed = settings.isError || memories.isError;
  const rows = memories.data ?? [];

  return (
    <Page
      title="Memory"
      description="Control what the assistant can remember and use across chats."
      rootPath="/settings"
      rootLabel="Settings"
    >
      <Section title="Controls">
        {settings.data ? (
          <ListCard>
            {!settings.data.globalEnabled ? (
              <ListRow>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">Memory is paused by an administrator</span>
                  <span className="text-muted-foreground text-xs">
                    Your preferences are preserved, but saved memories are not referenced and models
                    cannot save them automatically. You can still add, edit, and delete memories.
                  </span>
                </div>
              </ListRow>
            ) : null}
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">Reference saved memories</span>
                <span className="text-muted-foreground text-xs">
                  Include saved memories as optional context in new responses.
                </span>
              </div>
              <Switch
                checked={settings.data.referenceEnabled}
                onCheckedChange={(checked) => updateSetting("referenceEnabled", checked)}
                disabled={settingsMutation.isPending || !settings.data.globalEnabled}
                aria-label="Reference saved memories"
              />
            </ListRow>
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">Automatically save useful memories</span>
                <span className="text-muted-foreground text-xs">
                  Let tool-capable models save durable facts and preferences during a response.
                </span>
              </div>
              <Switch
                checked={settings.data.autoSaveEnabled}
                onCheckedChange={(checked) => updateSetting("autoSaveEnabled", checked)}
                disabled={settingsMutation.isPending || !settings.data.globalEnabled}
                aria-label="Automatically save useful memories"
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
              onClick={() => setEditing("new")}
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
            description="Try loading your memory settings again."
            onRetry={() => {
              void Promise.all([settings.refetch(), memories.refetch()]);
            }}
          />
        ) : settings.data === undefined || memories.data === undefined ? null : rows.length ===
          0 ? (
          <EmptyState
            icon={Brain02Icon}
            title="Nothing saved yet"
            description="Add a memory yourself, or enable automatic saving for useful facts and preferences."
            action={
              <Button size="sm" onClick={() => setEditing("new")}>
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
                onEdit={() => setEditing(memory)}
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

      <MemoryDialog
        memory={editing}
        open={editing !== null}
        pending={dialogPending}
        onPendingChange={setDialogPending}
        onOpenChange={(open) => {
          if (!open && !dialogPending) setEditing(null);
        }}
        onSaved={async () => {
          await invalidate();
          setEditing(null);
        }}
      />
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
  const hydrated = useHydrated();
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
          {hydrated && !Number.isNaN(updated.getTime()) ? (
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

function MemoryDialog({
  memory,
  open,
  pending,
  onPendingChange,
  onOpenChange,
  onSaved,
}: {
  memory: Memory | "new" | null;
  open: boolean;
  pending: boolean;
  onPendingChange: (pending: boolean) => void;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={false}>
        {memory ? (
          <MemoryForm
            key={memory === "new" ? "new" : memory.id}
            memory={memory}
            onPendingChange={onPendingChange}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function MemoryForm({
  memory,
  onPendingChange,
  onSaved,
}: {
  memory: Memory | "new";
  onPendingChange: (pending: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const editing = memory !== "new";
  const [pending, setPending] = useState(false);
  const updatePending = (next: boolean) => {
    setPending(next);
    onPendingChange(next);
  };
  const form = useAppForm({
    defaultValues: { content: editing ? memory.content : "" },
    validators: { onSubmit: Schema.toStandardSchemaV1(MemoryFormSchema) },
    onSubmit: async ({ value }) => {
      const content = value.content.trim();
      updatePending(true);
      try {
        const outcome = editing
          ? await updateMemory({ data: { memoryId: memory.id, content } })
          : await createMemory({ data: { content } });
        if (
          outcome.outcome === "created" ||
          outcome.outcome === "updated" ||
          outcome.outcome === "duplicate"
        ) {
          if (outcome.outcome === "duplicate") toast.info("That memory is already saved.");
          await onSaved();
          return;
        }
        toast.error(rejectionMessage(outcome));
      } catch {
        toast.error("Could not save the memory.");
      } finally {
        updatePending(false);
      }
    },
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{editing ? "Edit memory" : "Add memory"}</DialogTitle>
        <DialogDescription>
          Keep it short and durable. Do not store passwords, API keys, or other secrets.
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
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
            <DialogClose render={<Button variant="outline" disabled={pending} />}>
              Cancel
            </DialogClose>
            <form.SubmitButton disabled={pending}>
              {editing ? "Save changes" : "Add memory"}
            </form.SubmitButton>
          </DialogFooter>
        </form.AppForm>
      </form>
    </>
  );
}
