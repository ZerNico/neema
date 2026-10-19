import { accountName } from "~/modules/integrations/schema.ts";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { ImageModelSettingRow } from "~/modules/images/ui/image-model-select.tsx";
import { PreferredModelRow } from "~/modules/chat/ui/preferred-model-row.tsx";
import { KNOWLEDGE_LIMITS } from "~/modules/knowledge/schema.ts";
import { CollectionsField } from "~/modules/knowledge/ui/collections-field.tsx";
import { CollectionDialog } from "~/modules/knowledge/ui/knowledge-page.tsx";
import { myIntegrationsQuery } from "~/modules/integrations/client/queries.ts";
import { IntegrationLogo } from "~/modules/integrations/ui/integration-logo.tsx";
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";
import { SkillsField } from "~/modules/skills/ui/skills-field.tsx";
import { EMPTY_SCHEDULE_DRAFT } from "../draft-schema.ts";
import { ScheduleAllowanceFields } from "./schedule-allowance-fields.tsx";
import { ScheduleChatField } from "./schedule-chat-field.tsx";
import { ScheduleNotifyField } from "./schedule-notify-field.tsx";
import { ScheduleTimingFields } from "./schedule-timing-fields.tsx";
import { withForm } from "~/ui/form/app-form.ts";
import { ListCard, ListRow, Section } from "~/ui/page-shell.tsx";
import { Button } from "~/ui/primitives/button";
import { Switch } from "~/ui/primitives/switch";

/** The detail page and the chat draft panel share these; each host owns persistence. */
export const ScheduleSettingsFields = withForm({
  defaultValues: EMPTY_SCHEDULE_DRAFT,
  render: function ScheduleSettingsFields({ form }) {
    const integrations = useQuery(myIntegrationsQuery);
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
        <ScheduleNotifyField form={form} />
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
            <form.Field name="modelId">
              {(field) => (
                <PreferredModelRow
                  value={field.state.value}
                  onChange={field.handleChange}
                  errors={field.state.meta.errors}
                />
              )}
            </form.Field>
            <form.Field name="imageModelId">
              {(field) => (
                <ImageModelSettingRow
                  value={field.state.value}
                  onChange={(modelId) => field.handleChange(modelId)}
                  description="Each run draws with it."
                />
              )}
            </form.Field>
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
            {(field) => (
              <CollectionsField
                value={field.state.value}
                onChange={field.handleChange}
                errors={field.state.meta.errors}
              >
                <div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (field.state.value.length < KNOWLEDGE_LIMITS.maxCollectionsPerSelection)
                        setCreatingCollection(true);
                      else toast.error("Select at most five knowledge collections.");
                    }}
                  >
                    <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
                    New collection
                  </Button>
                </div>
              </CollectionsField>
            )}
          </form.Field>
        </Section>
        <Section
          title="Integrations"
          description="Nobody is there to approve during a run, so decide now how far each connected service may go. Anything more is refused, not asked."
        >
          <form.Field name="integrationGrants">
            {(field) => {
              const grants = field.state.value ?? [];
              // One row per account a run could act as, plus any granted one since lost.
              const rows = (integrations.data ?? []).flatMap((integration) => {
                const several = integration.connections.length > 1;
                const accounts = integration.connections
                  .filter(
                    (account) =>
                      account.status === "active" ||
                      grants.some((grant) => grant.connectionId === account.id),
                  )
                  .map((account) => ({
                    integration,
                    connectionId: account.id,
                    title: several
                      ? `${integration.name} · ${accountName(account)}`
                      : integration.name,
                    detail:
                      account.status === "active"
                        ? account.accountLabel
                        : "Not connected: runs will fail until you reconnect.",
                  }));
                const lost = grants
                  .filter(
                    (grant) =>
                      grant.integrationId === integration.id &&
                      !integration.connections.some((account) => account.id === grant.connectionId),
                  )
                  .map((grant) => ({
                    integration,
                    connectionId: grant.connectionId,
                    title: integration.name,
                    detail: "Its account was disconnected: turn this off or runs will fail.",
                  }));
                return [...accounts, ...lost];
              });
              if (rows.length === 0)
                return (
                  <p className="text-muted-foreground text-sm">
                    Connect a service in Settings → Integrations to let runs use it.
                  </p>
                );
              return (
                <ListCard>
                  {rows.map(({ integration, connectionId, title, detail }) => {
                    const grant = grants.find((entry) => entry.connectionId === connectionId);
                    const value = grant?.access ?? "none";
                    const rest = grants.filter((entry) => entry.connectionId !== connectionId);
                    return (
                      <Fragment key={connectionId}>
                        <ListRow>
                          <IntegrationLogo integrationId={integration.id} variant="tile" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{title}</p>
                            <p className="text-muted-foreground truncate text-xs">{detail}</p>
                          </div>
                          <ToggleGroup
                            value={[value]}
                            onValueChange={(values) => {
                              const next = values.at(-1);
                              if (next === "read" || next === "write")
                                field.handleChange([
                                  ...rest,
                                  { connectionId, integrationId: integration.id, access: next },
                                ]);
                              else if (next === "none") field.handleChange(rest);
                            }}
                            variant="outline"
                            size="sm"
                            spacing={0}
                            aria-label={`${title} during runs`}
                          >
                            <ToggleGroupItem value="none">Off</ToggleGroupItem>
                            <ToggleGroupItem value="read">Read</ToggleGroupItem>
                            <ToggleGroupItem value="write">Read and write</ToggleGroupItem>
                          </ToggleGroup>
                        </ListRow>
                        {grant ? (
                          <ScheduleAllowanceFields
                            kind={integration.kind}
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
            {(field) => (
              <SkillsField
                value={field.state.value ?? []}
                onChange={field.handleChange}
                errors={field.state.meta.errors}
                unavailableHint="Remove this dependency or restore access before the next run."
              />
            )}
          </form.Field>
        </Section>
        {creatingCollection ? (
          <CollectionDialog
            open
            onOpenChange={setCreatingCollection}
            onCreated={(collectionId) => {
              const current = form.getFieldValue("collectionIds");
              if (current.length < KNOWLEDGE_LIMITS.maxCollectionsPerSelection)
                form.setFieldValue("collectionIds", [...current, collectionId]);
            }}
          />
        ) : null}
      </>
    );
  },
});
