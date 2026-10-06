import { Cancel01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { chatModelsQuery } from "~/modules/chat/client/queries.ts";
import { browserTimeZone } from "~/modules/chat/client/time-zone.ts";
import { ModelPicker } from "~/modules/chat/ui/model-picker.tsx";
import { knowledgeCollectionsQuery } from "~/modules/knowledge/client/queries.ts";
import type { CollectionSummary } from "~/modules/knowledge/schema.ts";
import { CollectionDialog } from "~/modules/knowledge/ui/knowledge-page.tsx";
import { skillsQuery } from "~/modules/skills/client/queries.ts";
import { myIntegrationsQuery } from "~/modules/integrations/client/queries.ts";
import { IntegrationLogo } from "~/modules/integrations/ui/integration-logo.tsx";
import { integrationName } from "~/modules/integrations/ui/integration-name.ts";
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";
import { SkillPicker } from "~/modules/skills/ui/skill-picker.tsx";
import { EMPTY_SCHEDULE_DRAFT } from "../draft-schema.ts";
import { ScheduleAllowanceFields } from "./schedule-allowance-fields.tsx";
import { ScheduleChatField } from "./schedule-chat-field.tsx";
import { ScheduleTimingFields } from "./schedule-timing-fields.tsx";
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
import { FieldError } from "~/ui/primitives/field";
import { Switch } from "~/ui/primitives/switch";

/** The detail page and the chat draft panel share these; each host owns persistence. */
export const ScheduleSettingsFields = withForm({
  defaultValues: EMPTY_SCHEDULE_DRAFT,
  render: function ScheduleSettingsFields({ form }) {
    const modelsQuery = useQuery(chatModelsQuery);
    const models = modelsQuery.data ?? [];
    const collections = useQuery(knowledgeCollectionsQuery);
    const skills = useQuery(skillsQuery);
    const integrations = useQuery(myIntegrationsQuery);
    const selectedModel = (id: string | null) => models.find((model) => model.id === id) ?? null;
    const [skillPickerOpen, setSkillPickerOpen] = useState(false);
    const [skillAnchor, setSkillAnchor] = useState<HTMLButtonElement | null>(null);
    const [creatingCollection, setCreatingCollection] = useState(false);
    return (
      <>
        <div className="flex flex-col gap-5">
          <form.AppField name="name">
            {(field) => <field.TextField label="Name" placeholder="Morning briefing" />}
          </form.AppField>
        </div>
        <ScheduleTimingFields form={form} />
        <ScheduleChatField form={form} />
        <div>
          <form.AppField name="prompt">
            {(field) => (
              <field.TextareaField
                label="Prompt"
                placeholder="What should the chat do when this runs?"
                rows={6}
              />
            )}
          </form.AppField>
        </div>
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
                <span className="text-sm font-medium">Web search</span>
              </div>
              <form.Field name="searchEnabled">
                {(field) => (
                  <Switch
                    checked={field.state.value}
                    onCheckedChange={(checked) => field.handleChange(checked)}
                    aria-label="Web search"
                  />
                )}
              </form.Field>
            </ListRow>
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">Deep research</span>
              </div>
              <form.Field name="researchEnabled">
                {(field) => (
                  <Switch
                    checked={field.state.value}
                    onCheckedChange={(checked) => field.handleChange(checked)}
                    aria-label="Deep research"
                  />
                )}
              </form.Field>
            </ListRow>
          </ListCard>
        </Section>
        <Section title="Knowledge" description="A run needs your access to these at fire time.">
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
              const atLimit = field.state.value.length >= 5;
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
                                </span>
                              </span>
                            </ComboboxItem>
                          )}
                        </ComboboxList>
                      </ComboboxContent>
                    </Combobox>
                  )}
                  <div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        if (!atLimit) setCreatingCollection(true);
                        else toast.error("Select at most five knowledge collections.");
                      }}
                    >
                      <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
                      New collection
                    </Button>
                  </div>
                  {atLimit ? (
                    <p className="text-muted-foreground text-xs">Up to 5 collections.</p>
                  ) : null}
                  <FieldError errors={field.state.meta.errors} />
                </div>
              );
            }}
          </form.Field>
        </Section>
        <Section
          title="Integrations"
          description="Nobody is there to approve during a run, so decide now how far each connected service may go. Anything more is refused, not asked."
        >
          <form.Field name="integrationGrants">
            {(field) => {
              const grants = field.state.value ?? [];
              const connected = (integrations.data ?? []).filter(
                (integration) =>
                  integration.connection?.status === "active" ||
                  grants.some((grant) => grant.integrationId === integration.id),
              );
              if (connected.length === 0)
                return (
                  <p className="text-muted-foreground text-sm">
                    Connect a service in Settings → Integrations to let runs use it.
                  </p>
                );
              return (
                <ListCard>
                  {connected.map((integration) => {
                    const grant = grants.find((entry) => entry.integrationId === integration.id);
                    const value = grant?.access ?? "none";
                    const rest = grants.filter((entry) => entry.integrationId !== integration.id);
                    return (
                      <Fragment key={integration.id}>
                        <ListRow>
                          <IntegrationLogo integrationId={integration.id} variant="tile" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">
                              {integrationName(integration.id)}
                            </p>
                            <p className="text-muted-foreground truncate text-xs">
                              {integration.connection?.status === "active"
                                ? integration.connection.accountLabel
                                : "Not connected: runs will fail until you reconnect."}
                            </p>
                          </div>
                          <ToggleGroup
                            value={[value]}
                            onValueChange={(values) => {
                              const next = values.at(-1);
                              if (next === "read" || next === "write")
                                field.handleChange([
                                  ...rest,
                                  { integrationId: integration.id, access: next },
                                ]);
                              else if (next === "none") field.handleChange(rest);
                            }}
                            variant="outline"
                            size="sm"
                            spacing={0}
                            aria-label={`${integrationName(integration.id)} during runs`}
                          >
                            <ToggleGroupItem value="none">Off</ToggleGroupItem>
                            <ToggleGroupItem value="read">Read</ToggleGroupItem>
                            <ToggleGroupItem value="write">Read and write</ToggleGroupItem>
                          </ToggleGroup>
                        </ListRow>
                        {grant ? (
                          <ScheduleAllowanceFields
                            grant={grant}
                            onChange={(next) => field.handleChange([...rest, next])}
                          />
                        ) : null}
                      </Fragment>
                    );
                  })}
                </ListCard>
              );
            }}
          </form.Field>
        </Section>
        <Section title="Skills" description="A run needs your access to these at fire time.">
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
                                  "Remove this dependency or restore access before the next run."}
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
        {creatingCollection ? (
          <CollectionDialog
            open
            onOpenChange={setCreatingCollection}
            onCreated={(collectionId) => {
              const current = form.getFieldValue("collectionIds");
              if (current.length < 5)
                form.setFieldValue("collectionIds", [...current, collectionId]);
            }}
          />
        ) : null}
      </>
    );
  },
});

export const newScheduleDefaults = () => ({
  ...EMPTY_SCHEDULE_DRAFT,
  timezone: browserTimeZone(),
});
