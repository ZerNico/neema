import { Cancel01Icon, Delete02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Schema } from "effect";
import { useState } from "react";
import { toast } from "sonner";
import { EMPTY_AGENT_DRAFT } from "../draft-schema.ts";
import { AGENT_LIMITS, AgentIcon } from "../schema.ts";
import { chatModelsQuery } from "~/modules/chat/client/queries.ts";
import { AGENT_ICONS } from "~/modules/chat/ui/agent-icons.ts";
import { ModelPicker } from "~/modules/chat/ui/model-picker.tsx";
import { usableCustomToolsQuery } from "~/modules/custom-tools/client/queries.ts";
import { useIntegrationDirectory } from "~/modules/integrations/client/directory.ts";
import { IntegrationLogo } from "~/modules/integrations/ui/integration-logo.tsx";
import { ResourcePicker } from "~/ui/resource-picker.tsx";
import { knowledgeCollectionsQuery } from "~/modules/knowledge/client/queries.ts";
import { KNOWLEDGE_LIMITS, type CollectionSummary } from "~/modules/knowledge/schema.ts";
import { CollectionDialog } from "~/modules/knowledge/ui/knowledge-page.tsx";
import { skillsQuery } from "~/modules/skills/client/queries.ts";
import { SkillPicker } from "~/modules/skills/ui/skill-picker.tsx";
import { withForm } from "~/ui/form/app-form.ts";
import { ErrorState, ListCard, ListRow, ListSkeleton, Section } from "~/ui/page-shell.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
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

/** The page and the draft rail use the same fields; each host owns its form and persistence. */
export const AgentSettingsFields = withForm({
  defaultValues: EMPTY_AGENT_DRAFT,
  render: function AgentSettingsFields({ form }) {
    const integrations = useIntegrationDirectory();
    const modelsQuery = useQuery(chatModelsQuery);
    const models = modelsQuery.data ?? [];
    const collections = useQuery(knowledgeCollectionsQuery);
    const skills = useQuery(skillsQuery);
    const customTools = useQuery(usableCustomToolsQuery);
    const selectedModel = (id: string | null) => models.find((model) => model.id === id) ?? null;
    const [skillPickerOpen, setSkillPickerOpen] = useState(false);
    const [skillAnchor, setSkillAnchor] = useState<HTMLButtonElement | null>(null);
    const [customToolPickerOpen, setCustomToolPickerOpen] = useState(false);
    const [customToolAnchor, setCustomToolAnchor] = useState<HTMLButtonElement | null>(null);
    const [creatingCollection, setCreatingCollection] = useState(false);
    return (
      <>
        <div className="flex flex-col gap-5">
          <form.AppField name="name">
            {(field) => <field.TextField label="Name" placeholder="Contract reviewer" />}
          </form.AppField>
          <form.AppField name="description">
            {(field) => (
              <field.TextField
                label="Description"
                optional
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
          description="People using this agent need their own access to these."
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
          description="People using this agent need their own access to these."
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
        <Section
          title="Custom tools"
          description="Extra actions set up by an admin. A chat without an agent can use all of them; this agent uses only the ones picked here."
        >
          <form.Field name="customToolIds">
            {(field) => {
              const ids = field.state.value ?? [];
              return (
                <div className="space-y-3">
                  {ids.length > 0 ? (
                    <ListCard>
                      {ids.map((id) => {
                        const tool = customTools.data?.find((candidate) => candidate.id === id);
                        return (
                          <ListRow key={id}>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">
                                {tool?.name ?? "Unavailable custom tool"}
                              </p>
                              <p className="text-muted-foreground truncate text-xs">
                                {tool?.description ??
                                  "Remove this dependency or ask an admin to re-enable it."}
                              </p>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Remove ${tool?.name ?? "unavailable custom tool"}`}
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
                  {customTools.isError ? (
                    <ErrorState
                      title="Could not load custom tools"
                      onRetry={() => void customTools.refetch()}
                    />
                  ) : (
                    <Button
                      ref={setCustomToolAnchor}
                      type="button"
                      variant="outline"
                      disabled={!customTools.data || customTools.data.length === 0}
                      onClick={() => setCustomToolPickerOpen(true)}
                    >
                      <HugeiconsIcon icon={PlusSignIcon} data-icon="inline-start" strokeWidth={2} />
                      Add custom tools
                    </Button>
                  )}
                  <ResourcePicker
                    items={customTools.data ?? []}
                    selectedIds={ids}
                    onChange={field.handleChange}
                    open={customToolPickerOpen}
                    onOpenChange={setCustomToolPickerOpen}
                    anchor={customToolAnchor}
                    limit={20}
                    placeholder="Search custom tools…"
                    empty="No matching custom tools."
                  />
                  <FieldError errors={field.state.meta.errors} />
                </div>
              );
            }}
          </form.Field>
        </Section>
        <Section
          title="Integrations"
          description="Services this agent uses by default. Each person uses their own connected account; someone who hasn’t connected one simply won’t have it."
        >
          <form.Field name="integrationIds">
            {(field) => {
              const ids = field.state.value ?? [];
              return (
                <ListCard>
                  {integrations.list.map((integration) => (
                    <ListRow key={integration.id}>
                      <IntegrationLogo integrationId={integration.id} variant="tile" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{integration.name}</p>
                        <p className="text-muted-foreground truncate text-xs">
                          {integration.manifest.description}
                        </p>
                      </div>
                      <Switch
                        checked={ids.includes(integration.id)}
                        aria-label={`Use ${integration.name}`}
                        onCheckedChange={(checked) =>
                          field.handleChange(
                            checked
                              ? [...ids, integration.id]
                              : ids.filter((id) => id !== integration.id),
                          )
                        }
                      />
                    </ListRow>
                  ))}
                </ListCard>
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
                className="w-full flex-wrap"
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
            {/* Wraps in the narrow rail: the label keeps its line and the
                picker takes the rest, truncating long model names. */}
            <ListRow className="flex-wrap">
              <div className="flex min-w-24 shrink-0 flex-col">
                <span className="text-sm font-medium">Preferred model</span>
              </div>
              <form.Field name="modelId">
                {(field) => (
                  <div className="flex min-w-0 flex-1 flex-col items-end gap-1">
                    <ModelPicker
                      models={models}
                      value={field.state.value}
                      onChange={(modelId) => field.handleChange(modelId)}
                      side="bottom"
                      align="end"
                      // oxlint-disable-next-line react/no-unstable-nested-components -- a render prop, not a component
                      header={({ close }) => (
                        <div className="p-1.5 pb-0">
                          <button
                            type="button"
                            role="option"
                            aria-selected={field.state.value === null}
                            className="hover:bg-accent hover:text-accent-foreground flex w-full cursor-default items-center gap-2.5 rounded-2xl px-3 py-2 text-sm font-medium select-none"
                            onClick={() => {
                              close();
                              field.handleChange(null);
                            }}
                          >
                            No preference
                          </button>
                        </div>
                      )}
                      trigger={
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full min-w-0 justify-between"
                          aria-label="Preferred model"
                          aria-invalid={field.state.meta.errors.length > 0 || undefined}
                        />
                      }
                    >
                      <span className="truncate">
                        {selectedModel(field.state.value)?.displayName ??
                          (field.state.value ? "Unavailable model" : "No preference")}
                      </span>
                    </ModelPicker>
                    <FieldError errors={field.state.meta.errors} />
                  </div>
                )}
              </form.Field>
            </ListRow>
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">Web search by default</span>
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
                <span className="text-muted-foreground text-xs">For multi-step requests.</span>
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
          description="Shown when someone starts a chat with this agent."
        >
          <form.Field name="starters">
            {(field) => (
              <div className="flex flex-col gap-2">
                {field.state.value.map((_, index) => (
                  // oxlint-disable-next-line react/no-array-index-key -- Starter fields are positional; keying by editable text would remount them on every keystroke.
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
                        <FieldError errors={starterField.state.meta.errors} />
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
                <FieldError errors={field.state.meta.errors} />
              </div>
            )}
          </form.Field>
        </Section>
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
      </>
    );
  },
});
