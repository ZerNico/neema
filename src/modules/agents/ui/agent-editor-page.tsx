import {
  Cancel01Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  PlusSignIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { agentQuery } from "../client/queries.ts";
import { AGENT_LIMITS, AgentIcon, AgentSettings, type AgentDetail } from "../schema.ts";
import { createAgent, deleteAgent, updateAgent } from "../server/functions.ts";
import { chatModelsQuery } from "~/modules/chat/client/queries.ts";
import { AGENT_ICONS } from "~/modules/chat/ui/context-picker.tsx";
import { ModelPicker } from "~/modules/chat/ui/model-picker.tsx";
import type { CollectionSummary } from "~/modules/knowledge/schema.ts";
import { knowledgeCollectionsQuery } from "~/modules/knowledge/client/queries.ts";
import { KNOWLEDGE_LIMITS } from "~/modules/knowledge/schema.ts";
import { CollectionDialog } from "~/modules/knowledge/ui/knowledge-page.tsx";
import { skillsQuery } from "~/modules/skills/client/queries.ts";
import { SkillPicker } from "~/modules/skills/ui/skill-picker.tsx";
import { AccessDialog } from "~/modules/sharing/ui/access-dialog.tsx";
import { useConfirm } from "~/ui/confirm.tsx";
import { useAppForm } from "~/ui/form/app-form.tsx";
import {
  ErrorState,
  FormActions,
  ListCard,
  ListRow,
  ListSkeleton,
  Page,
  Section,
} from "~/ui/page-shell.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button, buttonVariants } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "~/ui/primitives/combobox";
import { Field, FieldError, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Switch } from "~/ui/primitives/switch";
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";

const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

const empty: AgentSettings = {
  name: "",
  description: "",
  icon: "robot",
  instructions: "",
  modelId: null,
  searchEnabled: false,
  planEnabled: false,
  starters: [],
  collectionIds: [],
  skillIds: [],
};

// Owner-only editor. Recipients start chats from the agent list instead.
export function AgentEditorPage({ agentId }: { agentId: string | null }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const detail = useQuery({ ...agentQuery(agentId ?? ""), enabled: agentId !== null });
  if (agentId !== null && detail.isError)
    return (
      <Page title="Agent" backTo="/agents" backLabel="Agents">
        <ErrorState
          title="Could not load this agent"
          description="It may have been deleted, or you no longer have access."
          onRetry={() => {
            void detail.refetch();
          }}
        />
      </Page>
    );
  if (agentId !== null && !detail.data) return null;
  const agent = detail.data ?? null;
  // A recipient can use the agent from the list; the editor is the owner's.
  // Showing "not found" rather than a read-only view keeps the page from
  // becoming a way to read instructions the owner did not choose to display.
  if (agent && !agent.canEdit)
    return (
      <Page title="Agent" backTo="/agents" backLabel="Agents">
        <ErrorState
          title="This agent isn’t yours to edit"
          description="You can start a chat with it from the Agents list."
        />
      </Page>
    );
  return (
    <AgentForm
      key={agent ? `${agent.id}:${agent.configRevision}` : "new"}
      agent={agent}
      onSaved={async (id) => {
        await queryClient.invalidateQueries({ queryKey: ["agents"] });
        if (!agent) await navigate({ to: "/agents/$agentId", params: { agentId: id } });
      }}
      onDelete={
        agent
          ? async () => {
              await confirm({
                title: `Delete “${agent.name}”?`,
                description:
                  "Chats that used it keep the instructions they ran with; nobody can select it again.",
                confirmLabel: "Delete agent",
              }).then(async (confirmed) => {
                if (!confirmed) return;
                try {
                  await deleteAgent({ data: { agentId: agent.id } });
                  await queryClient.invalidateQueries({ queryKey: ["agents"] });
                  await navigate({ to: "/agents" });
                } catch {
                  toast.error("Could not delete the agent.");
                }
              });
            }
          : undefined
      }
    />
  );
}

function AgentForm({
  agent,
  onSaved,
  onDelete,
}: {
  agent: AgentDetail | null;
  onSaved: (agentId: string) => Promise<void>;
  onDelete: (() => Promise<void>) | undefined;
}) {
  const { data: models } = useSuspenseQuery(chatModelsQuery);
  const collections = useQuery(knowledgeCollectionsQuery);
  const skills = useQuery(skillsQuery);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [skillAnchor, setSkillAnchor] = useState<HTMLButtonElement | null>(null);
  const formElement = useRef<HTMLFormElement>(null);
  const [invalidSubmit, setInvalidSubmit] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [creatingCollection, setCreatingCollection] = useState(false);
  const form = useAppForm({
    defaultValues: agent
      ? ({
          name: agent.name,
          description: agent.description,
          icon: agent.icon as AgentSettings["icon"],
          instructions: agent.instructions,
          modelId: agent.modelId,
          searchEnabled: agent.searchEnabled,
          planEnabled: agent.planEnabled,
          starters: [...agent.starters],
          collectionIds: agent.collections.map((collection) => collection.id),
          skillIds: (agent.skills ?? []).map((skill) => skill.id),
        } satisfies AgentSettings)
      : empty,
    validators: { onSubmit: Schema.toStandardSchemaV1(AgentSettings) },
    onSubmit: async ({ value }) => {
      try {
        const settings: AgentSettings = {
          ...value,
          starters: value.starters.map((starter) => starter.trim()).filter(Boolean),
        };
        if (agent) {
          await updateAgent({
            data: { agentId: agent.id, expectedRevision: agent.configRevision, ...settings },
          });
          await onSaved(agent.id);
          toast.success("Agent saved.");
        } else {
          const id = await createAgent({ data: settings });
          await onSaved(id);
        }
      } catch (error) {
        toast.error(message(error, "Could not save the agent."));
      }
    },
  });
  const remove = useMutation({ mutationFn: async () => onDelete?.() });
  const selectedModel = (id: string | null) => models.find((model) => model.id === id) ?? null;

  return (
    <Page
      title={agent ? agent.name : "New agent"}
      backTo="/agents"
      backLabel="Agents"
      actions={
        agent ? (
          <>
            <Link
              to="/"
              search={{ agent: agent.id }}
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              Start chat
            </Link>
            <Button size="sm" variant="outline" onClick={() => setSharing(true)}>
              <HugeiconsIcon icon={UserGroupIcon} strokeWidth={2} data-icon="inline-start" />
              Access
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button size="icon-sm" variant="ghost" aria-label="Agent actions" />}
              >
                <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* A menu item closes on activation, so it cannot carry a
                    spinner; disabling it is the pending signal. */}
                <DropdownMenuItem
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                  Delete agent
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : undefined
      }
    >
      <form
        ref={formElement}
        className="flex flex-col gap-8"
        onSubmit={(event) => {
          event.preventDefault();
          if (!form.state.isSubmitting)
            void form.handleSubmit().then(() => {
              if (form.state.isValid) {
                setInvalidSubmit(false);
                return;
              }
              setInvalidSubmit(true);
              requestAnimationFrame(() => {
                formElement.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
              });
            });
        }}
      >
        <div className="flex flex-col gap-5">
          <form.AppField name="name">
            {(field) => <field.TextField label="Name" placeholder="Contract reviewer" />}
          </form.AppField>
          <form.AppField name="description">
            {(field) => (
              <field.TextField
                label="Description (optional)"
                placeholder="What this agent is for, in one line."
              />
            )}
          </form.AppField>
        </div>
        <div>
          <form.AppField name="instructions">
            {(field) => (
              <field.TextareaField
                label="Instructions"
                placeholder="What should this agent do?"
                rows={8}
              />
            )}
          </form.AppField>
        </div>
        <Section
          title="Knowledge"
          description="Optional collections. People using this agent need separate access to them."
          actions={
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (
                  form.getFieldValue("collectionIds").length <
                  KNOWLEDGE_LIMITS.maxCollectionsPerSelection
                )
                  setCreatingCollection(true);
                else toast.error("Select at most five knowledge collections.");
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
              New collection
            </Button>
          }
        >
          <form.Field name="collectionIds">
            {(field) => {
              if (collections.isError)
                return (
                  <ErrorState
                    title="Could not load collections"
                    onRetry={() => void collections.refetch()}
                  />
                );
              if (collections.data === undefined)
                return <ListSkeleton rows={2} media="none" label="Loading collections" />;
              const known = collections.data;
              const attached = field.state.value.flatMap((id) => {
                const collection = known.find((candidate) => candidate.id === id);
                return collection ? [collection] : [];
              });
              const unavailable = field.state.value.filter(
                (id) => !known.some((candidate) => candidate.id === id),
              );
              const addable = known.filter(
                (collection) => !field.state.value.includes(collection.id),
              );
              const atLimit =
                field.state.value.length >= KNOWLEDGE_LIMITS.maxCollectionsPerSelection;
              const detach = (id: string) =>
                field.handleChange(field.state.value.filter((current) => current !== id));
              return (
                <div
                  role="group"
                  aria-label="Knowledge collections"
                  tabIndex={-1}
                  aria-invalid={field.state.meta.errors.length > 0 || undefined}
                  className="flex flex-col gap-3"
                >
                  {attached.length > 0 || unavailable.length > 0 ? (
                    <ListCard>
                      {attached.map((collection) => (
                        <ListRow key={collection.id}>
                          <div className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-sm font-medium">{collection.name}</span>
                            <span className="text-muted-foreground truncate text-xs">
                              {collection.documentCount} documents
                              {collection.ownerName ? ` · shared by ${collection.ownerName}` : ""}
                            </span>
                          </div>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="text-muted-foreground hover:text-foreground"
                            aria-label={`Remove ${collection.name}`}
                            onClick={() => detach(collection.id)}
                          >
                            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                          </Button>
                        </ListRow>
                      ))}
                      {unavailable.map((id) => (
                        <ListRow key={id}>
                          <span className="flex-1 text-sm">
                            A collection you can no longer read
                          </span>
                          <Badge variant="destructive">Unavailable</Badge>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="text-muted-foreground hover:text-foreground"
                            aria-label="Remove unavailable collection"
                            onClick={() => detach(id)}
                          >
                            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                          </Button>
                        </ListRow>
                      ))}
                    </ListCard>
                  ) : null}
                  {known.length === 0 && unavailable.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                      No collections yet.{" "}
                      <Link to="/knowledge" className="underline underline-offset-2">
                        Manage knowledge
                      </Link>
                    </p>
                  ) : (
                    // A searchable picker rather than a switch per row: the list
                    // grows with the account, the attached ones do not.
                    <Combobox
                      items={addable}
                      value={null}
                      disabled={atLimit || addable.length === 0}
                      onValueChange={(collection: CollectionSummary | null) => {
                        if (collection && !atLimit)
                          field.handleChange([...field.state.value, collection.id]);
                      }}
                      itemToStringLabel={(collection: CollectionSummary) => collection.name}
                      isItemEqualToValue={(a: CollectionSummary, b: CollectionSummary) =>
                        a.id === b.id
                      }
                      autoHighlight
                    >
                      <ComboboxTrigger
                        render={
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-fit"
                            disabled={atLimit || addable.length === 0}
                            aria-label="Add collection"
                          />
                        }
                      >
                        <HugeiconsIcon
                          icon={PlusSignIcon}
                          strokeWidth={2}
                          data-icon="inline-start"
                        />
                        Add collection
                      </ComboboxTrigger>
                      <ComboboxContent align="start" className="w-72">
                        <ComboboxInput placeholder="Search collections…" showTrigger={false} />
                        <ComboboxEmpty>No collections match</ComboboxEmpty>
                        <ComboboxList>
                          {(collection: CollectionSummary) => (
                            <ComboboxItem key={collection.id} value={collection}>
                              <span className="flex min-w-0 flex-col">
                                <span className="truncate">{collection.name}</span>
                                <span className="text-muted-foreground truncate text-xs">
                                  {collection.documentCount} documents
                                  {collection.ownerName
                                    ? ` · shared by ${collection.ownerName}`
                                    : ""}
                                </span>
                              </span>
                            </ComboboxItem>
                          )}
                        </ComboboxList>
                      </ComboboxContent>
                    </Combobox>
                  )}
                  {atLimit ? (
                    <p className="text-muted-foreground text-xs">
                      Up to {KNOWLEDGE_LIMITS.maxCollectionsPerSelection} collections.
                    </p>
                  ) : null}
                  <FieldError errors={field.state.meta.errors} />
                </div>
              );
            }}
          </form.Field>
        </Section>
        <Section
          title="Skills"
          description="Optional guidance this agent can load. People using it need separate access to each skill."
        >
          <form.Field name="skillIds">
            {(field) => {
              const ids = field.state.value ?? [];
              return (
                <div className="space-y-3">
                  {ids.length > 0 ? (
                    <ListCard>
                      {ids.map((id) => {
                        const skill = skills.data?.find((candidate) => candidate.id === id);
                        return (
                          <ListRow key={id}>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">
                                {skill?.name ?? "Unavailable skill"}
                              </p>
                              <p className="text-muted-foreground truncate text-xs">
                                {skill?.description ??
                                  "Remove this dependency or restore access before using the agent."}
                              </p>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Remove ${skill?.name ?? "unavailable skill"}`}
                              onClick={() =>
                                field.handleChange(ids.filter((value) => value !== id))
                              }
                            >
                              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                            </Button>
                          </ListRow>
                        );
                      })}
                    </ListCard>
                  ) : null}
                  {skills.isError ? (
                    <ErrorState
                      title="Could not load skills"
                      onRetry={() => void skills.refetch()}
                    />
                  ) : (
                    <Button
                      ref={setSkillAnchor}
                      type="button"
                      variant="outline"
                      disabled={!skills.data}
                      onClick={() => setSkillPickerOpen(true)}
                    >
                      <HugeiconsIcon icon={PlusSignIcon} data-icon="inline-start" strokeWidth={2} />
                      Add skills
                    </Button>
                  )}
                  <SkillPicker
                    items={skills.data ?? []}
                    selectedIds={ids}
                    onChange={field.handleChange}
                    open={skillPickerOpen}
                    onOpenChange={setSkillPickerOpen}
                    anchor={skillAnchor}
                    limit={20}
                  />
                  <FieldError errors={field.state.meta.errors} />
                </div>
              );
            }}
          </form.Field>
        </Section>
        <form.Field name="icon">
          {(field) => (
            <Field>
              <FieldLabel>Icon</FieldLabel>
              <ToggleGroup
                aria-invalid={field.state.meta.errors.length > 0 || undefined}
                value={[field.state.value]}
                onValueChange={(value) => {
                  const next = value.at(-1);
                  if (next && Schema.is(AgentIcon)(next)) field.handleChange(next);
                }}
                aria-label="Icon"
              >
                {(Object.keys(AGENT_ICONS) as Array<keyof typeof AGENT_ICONS>).map((icon) => (
                  <ToggleGroupItem key={icon} value={icon} aria-label={icon}>
                    <HugeiconsIcon icon={AGENT_ICONS[icon]} strokeWidth={2} />
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <FieldError errors={field.state.meta.errors} />
            </Field>
          )}
        </form.Field>
        <Section title="Model and tools">
          <ListCard>
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">Preferred model</span>
                <span className="text-muted-foreground text-xs">
                  People can choose a different model.
                </span>
              </div>
              <form.Field name="modelId">
                {(field) => (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-1">
                      <ModelPicker
                        models={models}
                        value={field.state.value}
                        onChange={(modelId) => field.handleChange(modelId)}
                        side="bottom"
                        align="end"
                        trigger={
                          <Button
                            size="sm"
                            variant="outline"
                            className="max-w-52"
                            aria-invalid={field.state.meta.errors.length > 0 || undefined}
                          />
                        }
                      >
                        <span className="truncate">
                          {selectedModel(field.state.value)?.displayName ??
                            (field.state.value ? "Unavailable model" : "No preference")}
                        </span>
                      </ModelPicker>
                      {field.state.value ? (
                        <Button size="sm" variant="ghost" onClick={() => field.handleChange(null)}>
                          Clear
                        </Button>
                      ) : null}
                    </div>
                    <FieldError errors={field.state.meta.errors} />
                  </div>
                )}
              </form.Field>
            </ListRow>
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">Web search by default</span>
                <span className="text-muted-foreground text-xs">
                  Start with web search on. People can turn it off.
                </span>
              </div>
              <form.Field name="searchEnabled">
                {(field) => (
                  <Switch
                    checked={field.state.value}
                    onCheckedChange={(checked) => field.handleChange(checked)}
                    aria-label="Web search by default"
                  />
                )}
              </form.Field>
            </ListRow>
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">Working checklist</span>
                <span className="text-muted-foreground text-xs">
                  Let the model keep a checklist for multi-step requests.
                </span>
              </div>
              <form.Field name="planEnabled">
                {(field) => (
                  <Switch
                    checked={field.state.value}
                    onCheckedChange={field.handleChange}
                    aria-label="Working checklist"
                  />
                )}
              </form.Field>
            </ListRow>
          </ListCard>
        </Section>
        <Section
          title="Conversation starters"
          description="Optional prompts shown when the agent is selected."
        >
          <form.Field name="starters">
            {(field) => (
              <div className="flex flex-col gap-2">
                {field.state.value.map((_, index) => (
                  <form.Field key={index} name={`starters[${index}]`}>
                    {(starterField) => (
                      <Field data-invalid={starterField.state.meta.errors.length > 0 || undefined}>
                        <div className="flex gap-2">
                          <Input
                            value={starterField.state.value}
                            onChange={(event) => starterField.handleChange(event.target.value)}
                            onBlur={starterField.handleBlur}
                            aria-invalid={starterField.state.meta.errors.length > 0 || undefined}
                            aria-label={`Starter ${index + 1}`}
                          />
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Remove starter ${index + 1}`}
                            onClick={() => field.removeValue(index)}
                          >
                            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                          </Button>
                        </div>
                        <FieldError
                          errors={starterField.state.meta.errors.map((error) => ({
                            message:
                              typeof error === "string"
                                ? error
                                : (error?.message ??
                                  "Enter a starter between 1 and 200 characters."),
                          }))}
                        />
                      </Field>
                    )}
                  </form.Field>
                ))}
                {field.state.value.length < AGENT_LIMITS.maxStarters ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-fit"
                    onClick={() => field.handleChange([...field.state.value, ""])}
                  >
                    <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
                    Add starter
                  </Button>
                ) : null}
                <FieldError
                  errors={field.state.meta.errors.map((error) => ({
                    message:
                      typeof error === "string"
                        ? error
                        : (error?.message ?? "Enter a starter between 1 and 200 characters."),
                  }))}
                />
              </div>
            )}
          </form.Field>
        </Section>
        {invalidSubmit ? (
          <FieldError>Check the highlighted fields before saving.</FieldError>
        ) : null}
        <form.AppForm>
          <FormActions>
            <form.SubmitButton>{agent ? "Save changes" : "Create agent"}</form.SubmitButton>
          </FormActions>
        </form.AppForm>
      </form>
      {agent ? (
        <AccessDialog
          resource={{ kind: "agent", id: agent.id }}
          title={agent.name}
          open={sharing}
          onOpenChange={setSharing}
        />
      ) : null}
      <CollectionDialog
        open={creatingCollection}
        onOpenChange={setCreatingCollection}
        onCreated={(collectionId) => {
          if (
            form.getFieldValue("collectionIds").length >=
            KNOWLEDGE_LIMITS.maxCollectionsPerSelection
          )
            return;
          form.setFieldValue("collectionIds", [
            ...form.getFieldValue("collectionIds"),
            collectionId,
          ]);
        }}
      />
    </Page>
  );
}
