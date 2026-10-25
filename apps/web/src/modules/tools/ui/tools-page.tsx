import { NumberField } from "./tool-fields.tsx";
import { useInvalidateTools } from "../client/use-invalidate-tools.ts";
import { integerBetween } from "./integer-between.ts";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { toast } from "sonner";
import { useAppForm } from "~/ui/form/app-form.ts";
import { FormActions, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { SaveLabel, SaveStatus } from "~/ui/save-status.tsx";
import { useSaveStatus } from "~/ui/use-save-status.ts";
import { Switch } from "~/ui/primitives/switch";
import { RESEARCH_SEARCH_BUDGET, type WebSearchConfig } from "../schema.ts";
import { updateToolSettings } from "../server/functions.ts";
import { toastError } from "~/ui/error-toast.ts";
import { PresentationFontsRow } from "~/modules/presentations/ui/presentation-fonts.tsx";
import { SearchProviderRows } from "./search-providers.tsx";
import {
  memoryToolQuery,
  webSearchToolQuery,
  urlReaderToolQuery,
  officeFilesToolQuery,
  interactiveUiToolQuery,
  mapsToolQuery,
  imageGenerationToolQuery,
} from "../client/queries.ts";
import { readInteractiveUi, readMaps, type MapServices } from "~/modules/genui/settings.ts";
import { m } from "~/paraglide/messages.js";

// Built where they are used: their messages are read in the page's locale.
const webSearchForm = () =>
  Schema.Struct({
    maxResults: integerBetween(1, 20),
    researchMaxSearchQueries: integerBetween(
      RESEARCH_SEARCH_BUDGET.min,
      RESEARCH_SEARCH_BUDGET.max,
    ),
  });

const urlReaderForm = () =>
  Schema.Struct({
    perPageCharCap: integerBetween(1000, 20000),
  });

export function ToolsPage() {
  return (
    <Page title={m.tools_page_title()} description={m.tools_page_description()}>
      <MemorySection />
      <WebSearchSection />
      <UrlReaderSection />
      <OfficeFilesSection />
      <ImageGenerationSection />
      <InteractiveUiSection />
      <MapsSection />
    </Page>
  );
}

function MemorySection() {
  const { data: tool } = useSuspenseQuery(memoryToolQuery);
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateToolSettings({ data: { tool: "memory", enabled } }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "tools"] }),
        queryClient.invalidateQueries({ queryKey: ["memory"] }),
      ]),
    onError: (error) => toastError(m.tools_memory_error_update(), error),
  });

  return (
    <Section title={m.tools_memory_title()}>
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">{m.tools_memory_label()}</span>
            <span className="text-muted-foreground text-xs">{m.tools_memory_description()}</span>
          </div>
          <Switch
            checked={tool.enabled}
            onCheckedChange={(checked) => toggle.mutate(checked)}
            disabled={toggle.isPending}
            aria-label={m.tools_memory_toggle()}
          />
        </ListRow>
      </ListCard>
    </Section>
  );
}

function WebSearchSection() {
  const { data: tool } = useSuspenseQuery(webSearchToolQuery);
  const invalidate = useInvalidateTools();
  const config = tool.config as Partial<WebSearchConfig>;

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateToolSettings({ data: { tool: "web_search", enabled } }),
    onSuccess: invalidate,
    onError: (error) => toastError(m.tools_web_search_error_update(), error),
  });

  const { justSaved, markSaved } = useSaveStatus();
  const searchForm = webSearchForm();
  const form = useAppForm({
    defaultValues: {
      maxResults: String(config.maxResults ?? 8),
      researchMaxSearchQueries: String(
        config.researchMaxSearchQueries ?? RESEARCH_SEARCH_BUDGET.default,
      ),
    },
    validators: { onSubmit: Schema.toStandardSchemaV1(searchForm) },
    onSubmit: async ({ value }) => {
      try {
        await updateToolSettings({
          data: {
            tool: "web_search",
            maxResults: Number(value.maxResults),
            researchMaxSearchQueries: Number(value.researchMaxSearchQueries),
          },
        });
      } catch {
        toast.error(m.tools_web_search_error_save());
        return;
      }
      markSaved();
      form.reset(value);
      await invalidate();
    },
  });

  return (
    <Section title={m.tools_web_search_title()}>
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">{m.tools_web_search_label()}</span>
            <span className="text-muted-foreground text-xs">
              {m.tools_web_search_description()}
            </span>
          </div>
          <Switch
            checked={tool.enabled}
            onCheckedChange={(checked) => toggle.mutate(checked)}
            disabled={toggle.isPending}
            aria-label={m.tools_web_search_toggle()}
          />
        </ListRow>

        <SearchProviderRows onChanged={invalidate} />

        <ListRow className="flex-col items-stretch gap-3">
          <form
            noValidate
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
          >
            <form.Field
              name="maxResults"
              validators={{ onSubmit: Schema.toStandardSchemaV1(integerBetween(1, 20)) }}
            >
              {(field) => (
                <NumberField
                  field={field}
                  label={m.tools_web_search_max_results()}
                  description={m.tools_web_search_max_results_description()}
                  min={1}
                  max={20}
                />
              )}
            </form.Field>
            <form.Field
              name="researchMaxSearchQueries"
              validators={{
                onSubmit: Schema.toStandardSchemaV1(searchForm.fields.researchMaxSearchQueries),
              }}
            >
              {(field) => (
                <NumberField
                  field={field}
                  label={m.tools_web_search_research_queries()}
                  description={m.tools_web_search_research_queries_description()}
                  min={RESEARCH_SEARCH_BUDGET.min}
                  max={RESEARCH_SEARCH_BUDGET.max}
                  step={1}
                />
              )}
            </form.Field>
            <FormActions>
              <form.AppForm>
                <form.SubmitButton size="sm">
                  <SaveLabel justSaved={justSaved}>{m.common_save()}</SaveLabel>
                </form.SubmitButton>
              </form.AppForm>
              <SaveStatus justSaved={justSaved} />
            </FormActions>
          </form>
        </ListRow>
      </ListCard>
    </Section>
  );
}

// Lets the model fetch pages from user messages or search results.
// Fetches go out from this server with SSRF guarding (private addresses and
// redirects to them are refused); the page is extracted to markdown locally.
function UrlReaderSection() {
  const { data: tool } = useSuspenseQuery(urlReaderToolQuery);
  const invalidate = useInvalidateTools();

  const config = tool.config as { perPageCharCap?: number };

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateToolSettings({ data: { tool: "read_url", enabled } }),
    onSuccess: invalidate,
    onError: (error) => toastError(m.tools_url_reader_error_update(), error),
  });

  const { justSaved, markSaved } = useSaveStatus();
  const form = useAppForm({
    defaultValues: { perPageCharCap: String(config.perPageCharCap ?? 12000) },
    validators: { onSubmit: Schema.toStandardSchemaV1(urlReaderForm()) },
    onSubmit: async ({ value }) => {
      try {
        await updateToolSettings({
          data: { tool: "read_url", perPageCharCap: Number(value.perPageCharCap) },
        });
      } catch {
        toast.error(m.tools_url_reader_error_save());
        return;
      }
      markSaved();
      form.reset({ perPageCharCap: value.perPageCharCap });
      await invalidate();
    },
  });

  return (
    <Section title={m.tools_url_reader_title()}>
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">{m.tools_url_reader_label()}</span>
            <span className="text-muted-foreground text-xs">
              {m.tools_url_reader_description()}
            </span>
          </div>
          <Switch
            checked={tool.enabled}
            onCheckedChange={(checked) => toggle.mutate(checked)}
            disabled={toggle.isPending}
            aria-label={m.tools_url_reader_toggle()}
          />
        </ListRow>
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
                name="perPageCharCap"
                validators={{ onSubmit: Schema.toStandardSchemaV1(integerBetween(1000, 20000)) }}
              >
                {(field) => (
                  <NumberField
                    field={field}
                    label={m.tools_url_reader_char_cap()}
                    min={1000}
                    max={20000}
                    step={1000}
                  />
                )}
              </form.Field>
            </div>
            <FormActions>
              <form.AppForm>
                <form.SubmitButton size="sm">
                  <SaveLabel justSaved={justSaved}>{m.common_save()}</SaveLabel>
                </form.SubmitButton>
              </form.AppForm>
              <SaveStatus justSaved={justSaved} />
            </FormActions>
          </form>
        </ListRow>
      </ListCard>
    </Section>
  );
}

/**
 * Whether chats may create and edit Office files, and the fonts their previews
 * draw. Previews of existing files keep working when editing is off.
 */
function OfficeFilesSection() {
  const { data: tool } = useSuspenseQuery(officeFilesToolQuery);
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      updateToolSettings({ data: { tool: "office_files", enabled } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: officeFilesToolQuery.queryKey }),
    onError: (error) => toastError(m.tools_office_error_update(), error),
  });

  return (
    <Section title={m.tools_office_title()}>
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">{m.tools_office_label()}</span>
            <span className="text-muted-foreground text-xs">{m.tools_office_description()}</span>
          </div>
          <Switch
            checked={tool.enabled}
            onCheckedChange={(checked) => toggle.mutate(checked)}
            disabled={toggle.isPending}
            aria-label={m.tools_office_toggle()}
          />
        </ListRow>
        <PresentationFontsRow />
      </ListCard>
    </Section>
  );
}

/**
 * Whether chats are offered image generation. Nothing is offered until an
 * image model exists either; images already made stay in their answers.
 */
function ImageGenerationSection() {
  const { data: tool } = useSuspenseQuery(imageGenerationToolQuery);
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      updateToolSettings({ data: { tool: "image_generation", enabled } }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: imageGenerationToolQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: ["image-models"] }),
      ]),
    onError: (error) => toastError(m.tools_image_error_update(), error),
  });

  return (
    <Section title={m.tools_image_title()}>
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">{m.tools_image_label()}</span>
            <span className="text-muted-foreground text-xs">{m.tools_image_description()}</span>
          </div>
          <Switch
            checked={tool.enabled}
            onCheckedChange={(checked) => toggle.mutate(checked)}
            disabled={toggle.isPending}
            aria-label={m.tools_image_toggle()}
          />
        </ListRow>
      </ListCard>
    </Section>
  );
}

/**
 * Whether answers may contain interactive blocks, and whether their image
 * tags are looked up. Blocks already in earlier answers keep rendering.
 */
function InteractiveUiSection() {
  const { data: tool } = useSuspenseQuery(interactiveUiToolQuery);
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (patch: { enabled?: boolean; images?: boolean }) =>
      updateToolSettings({ data: { tool: "interactive_ui", ...patch } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: interactiveUiToolQuery.queryKey }),
    onError: (error) => toastError(m.tools_interactive_error_update(), error),
  });

  const settings = readInteractiveUi(tool);
  return (
    <Section title={m.tools_interactive_title()}>
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">{m.tools_interactive_label()}</span>
            <span className="text-muted-foreground text-xs">
              {m.tools_interactive_description()}
            </span>
          </div>
          <Switch
            checked={settings.enabled}
            onCheckedChange={(checked) => update.mutate({ enabled: checked })}
            disabled={update.isPending}
            aria-label={m.tools_interactive_toggle()}
          />
        </ListRow>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">{m.tools_interactive_images_label()}</span>
            <span className="text-muted-foreground text-xs">
              {m.tools_interactive_images_description()}
            </span>
          </div>
          <Switch
            checked={settings.images}
            onCheckedChange={(checked) => update.mutate({ images: checked })}
            disabled={update.isPending || !settings.enabled}
            aria-label={m.tools_interactive_images_toggle()}
          />
        </ListRow>
      </ListCard>
    </Section>
  );
}

/**
 * Places and routes: the route tool in any chat, and the maps interactive
 * answers draw. Its own section, since it works without interactive answers.
 */
function MapsSection() {
  const { data: tool } = useSuspenseQuery(mapsToolQuery);
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (enabled: boolean) => updateToolSettings({ data: { tool: "maps", enabled } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mapsToolQuery.queryKey }),
    onError: (error) => toastError(m.tools_maps_error_update(), error),
  });

  const settings = readMaps(tool);
  return (
    <Section title={m.tools_maps_title()}>
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">{m.tools_maps_label()}</span>
            <span className="text-muted-foreground text-xs">{m.tools_maps_description()}</span>
          </div>
          <Switch
            checked={settings.enabled}
            onCheckedChange={(checked) => update.mutate(checked)}
            disabled={update.isPending}
            aria-label={m.tools_maps_toggle()}
          />
        </ListRow>
        {settings.enabled ? <MapServicesRow services={settings.services} /> : null}
      </ListCard>
    </Section>
  );
}

const mapServicesForm = () => {
  const serviceUrl = Schema.String.check(
    Schema.isPattern(/^https:\/\/\S+$/, { message: m.tools_maps_url_invalid() }),
  );
  return Schema.Struct({
    styleLight: serviceUrl,
    styleDark: serviceUrl,
    geocoder: serviceUrl,
    routing: serviceUrl,
  });
};

/** Where maps get their tiles, places and routes. The public OpenStreetMap services by default. */
function MapServicesRow({ services }: { services: MapServices }) {
  const queryClient = useQueryClient();
  const { justSaved, markSaved } = useSaveStatus();
  const defaults = { ...services };
  const form = useAppForm({
    defaultValues: defaults,
    validators: { onSubmit: Schema.toStandardSchemaV1(mapServicesForm()) },
    onSubmit: async ({ value }) => {
      try {
        await updateToolSettings({ data: { tool: "maps", ...value } });
      } catch {
        toast.error(m.tools_maps_error_save());
        return;
      }
      markSaved();
      form.reset(value);
      await queryClient.invalidateQueries({ queryKey: mapsToolQuery.queryKey });
    },
  });
  return (
    <ListRow className="flex-col items-stretch gap-3">
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <form.AppField name="styleLight">
            {(field) => <field.TextField label={m.tools_maps_style_light()} type="url" />}
          </form.AppField>
          <form.AppField name="styleDark">
            {(field) => <field.TextField label={m.tools_maps_style_dark()} type="url" />}
          </form.AppField>
          <form.AppField name="geocoder">
            {(field) => <field.TextField label={m.tools_maps_geocoder()} type="url" />}
          </form.AppField>
          <form.AppField name="routing">
            {(field) => <field.TextField label={m.tools_maps_routing()} type="url" />}
          </form.AppField>
        </div>
        <FormActions>
          <form.AppForm>
            <form.SubmitButton size="sm">
              <SaveLabel justSaved={justSaved}>{m.common_save()}</SaveLabel>
            </form.SubmitButton>
          </form.AppForm>
          <SaveStatus justSaved={justSaved} />
        </FormActions>
      </form>
    </ListRow>
  );
}

// Local PDF text extraction, used when a model cannot take a PDF natively.
// Kept local on purpose, since the alternative would ship the user's document
// to a third-party parser.

// Semantic search for knowledge collections. Keyword search always works;
// this adds an embedding model. Two things are deliberately explicit here:
// enabling means document text is sent to that provider, and switching
// models asks whether existing vectors stay comparable. A name or matching
// dimension count alone never decides that.
