import { Brain02Icon, Delete02Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toastError } from "~/ui/error-toast.ts";
import {
  ErrorState,
  FormActions,
  ListCard,
  ListRow,
  ListSkeleton,
  Section,
} from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import { Field, FieldError, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { projectMemoriesQuery } from "../client/queries.ts";
import { PROJECT_MEMORY_LIMITS, type ProjectMemory } from "../schema.ts";
import { addProjectMemory, deleteProjectMemory, updateProjectMemory } from "../server/functions.ts";
import { m } from "~/paraglide/messages.js";

const failure = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * Facts the project keeps for every member's chats: decisions, conventions,
 * names. The assistant adds to it from project chats; editors curate it.
 */
export function ProjectMemorySection({
  projectId,
  editable,
}: {
  projectId: string;
  editable: boolean;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const memories = useQuery(projectMemoriesQuery(projectId));
  const [content, setContent] = useState("");
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["projects", "memories", projectId] });
  const add = useMutation({
    mutationFn: () => addProjectMemory({ data: { projectId, content: content.trim() } }),
    onSuccess: async () => {
      setContent("");
      await refresh();
    },
  });
  const rows = memories.data ?? [];
  return (
    <Section title={m.projects_memory_title()} description={m.projects_memory_description()}>
      {memories.isError ? (
        <ErrorState
          title={m.projects_memory_load_failed()}
          onRetry={() => {
            void memories.refetch();
          }}
        />
      ) : !memories.data ? (
        <ListSkeleton label={m.projects_memory_loading()} />
      ) : (
        <>
          {rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">{m.projects_memory_empty()}</p>
          ) : (
            <ListCard>
              {rows.map((memory) => (
                <MemoryRow
                  key={memory.id}
                  projectId={projectId}
                  memory={memory}
                  editable={editable}
                />
              ))}
            </ListCard>
          )}
          {editable ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (content.trim()) add.mutate();
              }}
            >
              <Field>
                <FieldLabel htmlFor={`${id}-memory`} className="sr-only">
                  {m.projects_memory_add_label()}
                </FieldLabel>
                <Input
                  id={`${id}-memory`}
                  value={content}
                  maxLength={PROJECT_MEMORY_LIMITS.content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder={m.projects_memory_placeholder()}
                  disabled={add.isPending}
                />
              </Field>
              {add.isError ? (
                <FieldError>{failure(add.error, m.projects_memory_add_failed())}</FieldError>
              ) : null}
              <FormActions>
                <PendingButton
                  type="submit"
                  size="sm"
                  variant="outline"
                  pending={add.isPending}
                  disabled={!content.trim()}
                >
                  {m.projects_memory_add()}
                </PendingButton>
              </FormActions>
            </form>
          ) : null}
        </>
      )}
    </Section>
  );
}

function MemoryRow({
  projectId,
  memory,
  editable,
}: {
  projectId: string;
  memory: ProjectMemory;
  editable: boolean;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["projects", "memories", projectId] });
  const save = useMutation({
    mutationFn: (content: string) =>
      updateProjectMemory({ data: { projectId, memoryId: memory.id, content } }),
    onSuccess: async () => {
      setDraft(null);
      await refresh();
    },
    onError: (error) => toastError(m.projects_memory_update_failed(), error),
  });
  const remove = useMutation({
    mutationFn: () => deleteProjectMemory({ data: { projectId, memoryId: memory.id } }),
    onSuccess: refresh,
    onError: (error) => toastError(m.projects_memory_delete_failed(), error),
  });
  const by =
    memory.origin === "model"
      ? m.projects_memory_by_assistant()
      : memory.createdByName
        ? m.projects_memory_added_by({ name: memory.createdByName })
        : m.projects_memory_added_by_member();
  return (
    <ListRow>
      <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
        <HugeiconsIcon icon={Brain02Icon} strokeWidth={2} className="size-4" />
      </div>
      {draft !== null ? (
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim()) save.mutate(draft.trim());
          }}
        >
          <Input
            aria-label={m.projects_memory_field()}
            value={draft}
            maxLength={PROJECT_MEMORY_LIMITS.content}
            onChange={(event) => setDraft(event.target.value)}
            disabled={save.isPending}
            autoFocus
          />
          <PendingButton type="submit" size="sm" pending={save.isPending} disabled={!draft.trim()}>
            {m.common_save()}
          </PendingButton>
          <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>
            {m.common_cancel()}
          </Button>
        </form>
      ) : (
        <>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm wrap-anywhere">{memory.content}</span>
            <span className="text-muted-foreground truncate text-xs">{by}</span>
          </div>
          {editable ? (
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={m.projects_memory_edit({ content: memory.content })}
                onClick={() => setDraft(memory.content)}
              >
                <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={m.projects_memory_delete({ content: memory.content })}
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              </Button>
            </>
          ) : null}
        </>
      )}
    </ListRow>
  );
}
