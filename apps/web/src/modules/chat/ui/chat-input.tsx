import { m } from "~/paraglide/messages.js";
import type { SkillSummary } from "~/modules/skills/schema.ts";
import { useTagSync } from "./use-tag-sync.ts";
import { SkillPicker } from "~/modules/skills/ui/skill-picker.tsx";
import {
  AiBrain01Icon,
  ArrowUp02Icon,
  Attachment01Icon,
  Book02Icon,
  FolderAddIcon,
  GlobalSearchIcon,
  PlugSocketIcon,
  PlusSignIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { capabilitiesQuery } from "~/modules/groups/client/queries.ts";
import { forwardRef, useId, useImperativeHandle, useMemo, useRef, useState } from "react";
import { chatModelsQuery, composerAvailabilityQuery } from "../client/queries.ts";
import { ChatTextarea, type ComposerFieldHandle } from "./chat-textarea.tsx";
import { CHAT_INPUT_SHELL_CLASS } from "./chat-input-shell.ts";
import { ModelPicker } from "./model-picker.tsx";
import { ImageModelMenu } from "~/modules/images/ui/image-model-picker.tsx";
import { imageModelsQuery } from "~/modules/images/client/queries.ts";
import {
  AgentPicker,
  CollectionPicker,
  AgentChip,
  ContextChip,
  ReferenceChip,
  ContextMenuItems,
  type ContextPickerKind,
  type ComposerContext,
} from "./context-picker.tsx";
import { collectionStatus } from "./collection-status.ts";
import { knowledgeCollectionsQuery } from "~/modules/knowledge/client/queries.ts";
import {
  type AttachmentUpload,
  type AttachmentUploads,
  attachmentUrl,
  createPastedTextFile,
  shouldPasteAsFile,
} from "~/modules/attachments/client/use-attachment-uploads.ts";
import { AttachmentChip, AttachmentChipRow } from "~/modules/attachments/ui/attachment-chip.tsx";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSwitchItem,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Kbd } from "~/ui/primitives/kbd";
import { Spinner } from "~/ui/primitives/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { cn } from "~/ui/utils";
import { useFileDrop } from "~/ui/use-file-drop.ts";
import { AnimatePresence } from "motion/react";
import * as motion from "motion/react-m";
import { CollapseItem, MotionSwap } from "~/ui/motion.tsx";
import { collapseMotion } from "~/ui/motion-presets.ts";
import { useAppReducedMotion } from "~/ui/reduced-motion.ts";
import { Disclosure, DisclosureContent } from "~/ui/disclosure.tsx";
import type {
  ComposerIntegration,
  ComposerIntegrations,
} from "~/modules/integrations/client/use-chat-integrations.ts";
import { AddIntegrationDialog } from "~/modules/integrations/ui/add-integration-dialog.tsx";
import { IntegrationLogo } from "~/modules/integrations/ui/integration-logo.tsx";
import type { MessageReference } from "../references.ts";
import type { ComposerFolders } from "~/modules/computer/client/use-composer-folders.ts";

/** A folder's guest path, the one the model uses: not words to translate. */
const folderPath = (name: string) => `/folders/${name}`;
import type { ReasoningEffort } from "~/modules/providers/model-config.ts";

const effortLabels: Record<ReasoningEffort, () => string> = {
  none: m.chat_effort_off,
  minimal: m.chat_effort_minimal,
  low: m.chat_effort_low,
  medium: m.chat_effort_medium,
  high: m.chat_effort_high,
  xhigh: m.chat_effort_xhigh,
  max: m.chat_effort_max,
};

// Stored chips preview from the authenticated route; an image still in
// flight previews from its local object URL.
const previewFor = (item: AttachmentUpload): string | null => {
  if (item.status === "complete" && item.attachment) return attachmentUrl(item.attachment.id);
  if (item.kind === "image") return item.previewUrl;
  return null;
};

/** The chat's image model as the composer shows it; a pick goes with the next send or retry. */
export interface ImageModelChoice {
  readonly value: string | null;
  /** The model the chat keeps, used when the pick is gone. */
  readonly lock?: string | null | undefined;
  /** The agent's image model, which the next answer falls back to before the admin's first. */
  readonly agentPreference?: string | null | undefined;
  readonly onChange: (modelId: string) => void;
}

const sharesIntegration = (items: ReadonlyArray<ComposerIntegration>, item: ComposerIntegration) =>
  items.some(
    (other) =>
      other.integrationId === item.integrationId && other.connectionId !== item.connectionId,
  );

/** The "@" rows: one per integration, naming its accounts only when there are several. */
const mentionableIntegrations = (items: ReadonlyArray<ComposerIntegration>) => {
  const byIntegration = new Map<string, ComposerIntegration[]>();
  for (const item of items)
    byIntegration.set(item.integrationId, [...(byIntegration.get(item.integrationId) ?? []), item]);
  return [...byIntegration.values()].map((accounts) => {
    const first = accounts[0]!;
    const named = accounts.flatMap((item) => (item.account ? [item.account] : []));
    return {
      id: first.integrationId,
      label: first.name,
      ...(accounts.some((item) => item.enabled) ? { meta: "on" } : {}),
      ...(named.length > 1 ? { description: named.join(" · ") } : {}),
      search: `${first.integrationId} ${first.name} ${named.join(" ")}`,
    };
  });
};

export const ChatInput = forwardRef<
  ComposerFieldHandle,
  {
    value: string;
    onValueChange: (value: string) => void;
    onSubmit: () => void;
    onCancel?: (() => void) | undefined;
    /** Replaces the send button while a response is generating. */
    onStop?: (() => void) | undefined;
    /**
     * A live response does not block the composer: submitting adds the draft to
     * the conversation's queue instead. Stop moves beside the primary button so
     * both remain reachable while typing.
     */
    queueing?: boolean | undefined;
    /** What submitting while queueing does; editing a queued message saves it. */
    queueLabel?: string | undefined;
    disabled: boolean;
    textareaDisabled?: boolean;
    controlsDisabled?: boolean;
    modelId: string | null;
    /** A pick in the model menu; the owner resolves what is sent. */
    onModelChange: (modelId: string) => void;
    searchEnabled: boolean;
    onSearchEnabledChange: (enabled: boolean) => void;
    reasoningEffort?: ReasoningEffort | null | undefined;
    onReasoningEffortChange?: ((effort: ReasoningEffort | null) => void) | undefined;
    researchEnabled?: boolean;
    onResearchEnabledChange?: (enabled: boolean) => void;
    imageModel?: ImageModelChoice | undefined;
    /** Owner-held upload state; research remains available without uploads. */
    attachments?: AttachmentUploads | undefined;
    /** Agent and collections for the next turn; absent hides the controls (edits). */
    context?: ComposerContext | undefined;
    skills?:
      | {
          items: readonly SkillSummary[];
          selectedIds: readonly string[];
          onChange: (ids: string[]) => void;
        }
      | undefined;
    /** Connected services this chat may use; absent hides the controls (edits). */
    integrations?: ComposerIntegrations | undefined;
    /** The chat's folders on this machine, in the desktop app only; absent hides them. */
    folders?: ComposerFolders | undefined;
    /** The agent or schedule this message is about, shown as chips. */
    references?:
      | {
          items: readonly MessageReference[];
          onRemove: (reference: MessageReference) => void;
        }
      | undefined;
    placeholder?: string;
    textareaLabel?: string;
    autoFocus?: boolean;
    submitLabel?: string;
    className?: string;
  }
>(function ChatInput(
  {
    value,
    onValueChange,
    onSubmit,
    onCancel,
    onStop,
    disabled,
    queueing = false,
    queueLabel = m.chat_composer_add_to_queue(),
    textareaDisabled = disabled,
    controlsDisabled = disabled,
    modelId,
    onModelChange,
    searchEnabled,
    onSearchEnabledChange,
    reasoningEffort = null,
    onReasoningEffortChange,
    researchEnabled = false,
    onResearchEnabledChange,
    imageModel,
    attachments,
    context,
    skills,
    integrations,
    references,
    folders,
    placeholder = m.chat_composer_placeholder(),
    textareaLabel,
    autoFocus = false,
    submitLabel = m.chat_composer_send(),
    className,
  },
  forwardedRef,
) {
  // Callers get the field's handle; the tag sync below needs it too.
  const textareaRef = useRef<ComposerFieldHandle>(null);
  useImperativeHandle(forwardedRef, () => ({
    focus: (options) => textareaRef.current?.focus(options),
    value: () => textareaRef.current?.value() ?? value,
    insertTags: (tags) => textareaRef.current?.insertTags(tags),
    removeTags: (kind, ids) => textareaRef.current?.removeTags(kind, ids),
  }));
  const { data: models } = useSuspenseQuery(chatModelsQuery);
  const { data: capabilities } = useQuery(capabilitiesQuery);
  const { data: searchAvailability } = useQuery({
    ...composerAvailabilityQuery,
    select: (available) => available.search,
  });
  const { data: researchAvailability } = useQuery({
    ...composerAvailabilityQuery,
    select: (available) => available.research,
    enabled:
      !!capabilities?.deepResearch &&
      !!capabilities.webSearch &&
      (onResearchEnabledChange !== undefined || researchEnabled),
  });
  const researchHintId = useId();
  // Where a dropped file goes: a server upload, in every chat.
  const target = capabilities?.attachments ? attachments : undefined;
  const canChooseAgent = !!capabilities?.agentsUse;
  const canChooseKnowledge = !!capabilities?.knowledgeUse;
  const canChooseSkills = !!capabilities?.skillsUse;
  const canResearch = !!capabilities?.deepResearch && !!capabilities.webSearch;
  const modeDisabled = controlsDisabled || !!target?.queued || !onResearchEnabledChange;
  const reduced = useAppReducedMotion();
  const rowMotion = collapseMotion(reduced);
  // Queueing owns the primary button only while there is something to queue,
  // so an empty composer still offers Stop where people expect it.
  const queueDraft = queueing && (value.trim() !== "" || (attachments?.items.length ?? 0) > 0);
  const stopping = !!onStop && !queueDraft;
  const action = stopping ? "stop" : target?.queued ? "upload" : "send";
  const actionLabel = stopping
    ? m.chat_composer_stop()
    : attachments?.queued
      ? m.chat_composer_sending_after_uploads()
      : queueDraft
        ? queueLabel
        : submitLabel;
  // Everything the "+" menu can offer besides attaching files. Three things key
  // off this: the trigger's label, whether it's enabled, and the menu width.
  // They drifted apart when Skills was added to the menu without being added
  // to any of them, so they read it from one place now.
  const [addingIntegration, setAddingIntegration] = useState(false);
  const { data: imageModels = [] } = useQuery({ ...imageModelsQuery, enabled: !!imageModel });
  const canChooseImageModel = !!imageModel && imageModels.length > 0;
  const hasTools =
    (!!context && (canChooseKnowledge || (canChooseAgent && !context.agentLocked))) ||
    canChooseImageModel ||
    (!!skills && canChooseSkills) ||
    (canResearch && (!!onResearchEnabledChange || researchEnabled)) ||
    // Only when there is something to connect or already connected.
    !!(integrations && (integrations.items.length || integrations.canAdd));
  const menuLabel = hasTools
    ? m.chat_composer_add_files_or_tools()
    : m.chat_composer_add_attachment();
  // "#" offers the same collections the Knowledge popup does: not the agent's
  // own, which come with it. Selecting one commits immediately.
  const knowledge = useQuery({
    ...knowledgeCollectionsQuery,
    enabled: !!context && canChooseKnowledge,
  });
  const mentionableCollections = useMemo(() => {
    if (!context || controlsDisabled || !canChooseKnowledge) return undefined;
    const selected = new Set(context.selection.collectionIds);
    const full = selected.size >= context.maxCollections;
    return {
      // Added ones stay listed, to be named again in the text; at the cap only
      // they are.
      items: (knowledge.data ?? [])
        .filter(
          (collection) =>
            !context.agentCollectionIds.has(collection.id) &&
            (!full || selected.has(collection.id)),
        )
        .map((collection) => ({
          id: collection.id,
          label: collection.name,
          description: collection.description || collectionStatus(collection),
        })),
      onSelect: (id: string) => {
        if (!selected.has(id)) context.onCollectionsChange([...selected, id]);
      },
    };
  }, [context, controlsDisabled, canChooseKnowledge, knowledge.data]);
  useTagSync(value, textareaRef, [
    ...(skills
      ? [
          {
            kind: "skill" as const,
            selected: skills.selectedIds,
            nameOf: (id: string) => skills.items.find((item) => item.id === id)?.name,
            canSelect: (id: string) => skills.items.some((item) => item.id === id),
            select: (ids: readonly string[]) =>
              skills.onChange([...new Set([...skills.selectedIds, ...ids])].slice(0, 5)),
            deselect: (ids: readonly string[]) =>
              skills.onChange(skills.selectedIds.filter((id) => !ids.includes(id))),
          },
        ]
      : []),
    ...(context
      ? [
          {
            kind: "collection" as const,
            selected: context.selection.collectionIds,
            nameOf: (id: string) =>
              knowledge.data?.find((collection) => collection.id === id)?.name ??
              (knowledge.isSuccess ? m.chat_composer_unavailable_collection() : undefined),
            canSelect: (id: string) =>
              !!knowledge.data?.some((collection) => collection.id === id) &&
              !context.agentCollectionIds.has(id),
            select: (ids: readonly string[]) =>
              context.onCollectionsChange([
                ...new Set([...context.selection.collectionIds, ...ids]),
              ]),
            deselect: (ids: readonly string[]) =>
              context.onCollectionsChange(
                context.selection.collectionIds.filter((id) => !ids.includes(id)),
              ),
          },
        ]
      : []),
  ]);
  // A context row closes the menu first and opens its popup once the menu is
  // gone, anchored to the same "+" button: two overlays returning focus to
  // each other is what a submenu would have avoided and this avoids too.
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false);
  const [pendingPicker, setPendingPicker] = useState<ContextPickerKind | "skills" | null>(null);
  const [picker, setPicker] = useState<ContextPickerKind | "skills" | null>(null);
  // The popup opens on the side the menu did: on an empty new chat both drop
  // below the composer, and a picker above it would send the pointer across it.
  const menuPopup = useRef<HTMLDivElement>(null);
  const [pickerSide, setPickerSide] = useState<"top" | "bottom">("top");
  const choosePicker = (kind: ContextPickerKind | "skills") => {
    setPickerSide(menuPopup.current?.dataset.side === "bottom" ? "bottom" : "top");
    setPendingPicker(kind);
  };
  const { data: parsingAvailability } = useQuery({
    ...composerAvailabilityQuery,
    select: (available) => available.documentParsing,
    enabled: attachments !== undefined,
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const noModels = models.length === 0;
  const selectedModel = models.find((model) => model.id === modelId);
  // Tools never depend on which model is selected: the gateway polyfills
  // prompt-based calling for models without native support. Only an empty
  // model list hides the toggle, since nothing could be sent anyway.
  const searchAvailable =
    !!capabilities?.webSearch &&
    (searchAvailability?.enabled ?? false) &&
    selectedModel !== undefined;

  const researchUnavailableReason = !researchAvailability
    ? m.chat_composer_research_checking()
    : !researchAvailability.configured || !researchAvailability.enabled
      ? m.chat_composer_research_needs_tools()
      : null;

  // Parsing lets a PDF through on a model without native file input; while the
  // query is still loading we say nothing rather than flash a wrong warning.
  const parsingUsable = parsingAvailability
    ? parsingAvailability.configured && parsingAvailability.enabled
    : true;

  const warningFor = (item: AttachmentUpload): string | null => {
    if (item.status === "error") return null;
    if (item.kind === "image" && selectedModel && !selectedModel.capabilities.vision) {
      return m.chat_composer_model_cannot_read_images({ model: selectedModel.displayName });
    }
    if (
      item.kind === "pdf" &&
      selectedModel &&
      !selectedModel.capabilities.files &&
      !parsingUsable
    ) {
      return m.chat_composer_model_cannot_read_pdfs({ model: selectedModel.displayName });
    }
    return null;
  };

  const items = attachments?.items ?? [];
  const blocked =
    items.some((item) => item.status === "error") ||
    items.some((item) => warningFor(item) !== null);
  // The agent's collections count toward the per-message limit too.
  const extraCollections = context
    ? context.selection.collectionIds.length - context.maxCollections
    : 0;
  const collectionsReason =
    extraCollections > 0 ? m.chat_composer_too_many_collections({ count: extraCollections }) : null;
  const usable = items.filter((item) => item.status !== "error").length;
  const canSubmit =
    !disabled &&
    !!selectedModel &&
    !blocked &&
    !(researchEnabled && (!canResearch || researchUnavailableReason)) &&
    !collectionsReason &&
    !target?.queued &&
    (value.trim() !== "" || usable > 0);

  const submit = () => {
    if (canSubmit) onSubmit();
  };

  const pickFiles = () => fileInputRef.current?.click();

  const { dragging, handlers: dropHandlers } = useFileDrop({
    enabled: target !== undefined && !controlsDisabled,
    onDrop: (files) => target?.addFiles(files),
  });

  return (
    <div
      className={cn("relative", CHAT_INPUT_SHELL_CLASS, dragging && "border-ring/60", className)}
      {...dropHandlers}
    >
      {/* Present on the first render when an edit opens with files or skills, so
          the row is already full height for the edit swap's measurement. */}
      <AnimatePresence initial={false}>
        {(references && references.items.length > 0) ||
        (folders && folders.items.length > 0) ||
        (attachments && items.length > 0) ||
        (context?.selection.agent && !context.agentLocked) ? (
          <motion.div key="chips" {...rowMotion}>
            <AttachmentChipRow className="px-3 pt-3">
              <AnimatePresence initial={false}>
                {/* What the message is about comes first. */}
                {references?.items.map((reference) => (
                  <CollapseItem key={`${reference.kind}:${reference.id}`}>
                    <ReferenceChip
                      reference={reference}
                      onRemove={controlsDisabled ? undefined : () => references.onRemove(reference)}
                    />
                  </CollapseItem>
                ))}
              </AnimatePresence>
              <AnimatePresence initial={false}>
                {folders?.items.map((folder) => (
                  <CollapseItem key={`folder:${folder.name}`}>
                    <ContextChip
                      item={{
                        kind: "folder",
                        id: folder.name,
                        name: folder.name,
                        note: folder.readOnly
                          ? `${folderPath(folder.name)} · ${m.computer_folder_read_only()}`
                          : folderPath(folder.name),
                      }}
                      onRemove={controlsDisabled ? undefined : () => folders.onRemove(folder.name)}
                    />
                  </CollapseItem>
                ))}
              </AnimatePresence>
              {/* Context first: it frames the files that follow. */}
              {context ? (
                <AgentChip
                  agent={context.selection.agent}
                  agentLocked={context.agentLocked}
                  onAgentChange={context.onAgentChange}
                  disabled={controlsDisabled}
                />
              ) : null}
              <AnimatePresence initial={false}>
                {attachments
                  ? items.map((item) => (
                      <CollapseItem key={item.localId}>
                        <AttachmentChip
                          item={item}
                          warning={warningFor(item)}
                          onRemove={
                            controlsDisabled ? undefined : () => attachments.remove(item.localId)
                          }
                          preview={previewFor(item)}
                        />
                      </CollapseItem>
                    ))
                  : null}
              </AnimatePresence>
            </AttachmentChipRow>
          </motion.div>
        ) : null}
      </AnimatePresence>
      {target?.notice ? (
        <p className="text-muted-foreground px-4 pt-2 text-xs">{target.notice}</p>
      ) : null}

      <ChatTextarea
        ref={textareaRef}
        skills={
          skills && canChooseSkills && !controlsDisabled
            ? {
                // Added ones stay listed; at five only they are.
                items: skills.items
                  .filter(
                    (item) => skills.selectedIds.length < 5 || skills.selectedIds.includes(item.id),
                  )
                  .map((item) => ({
                    id: item.id,
                    label: item.name,
                    ...(item.ownerName ? { meta: item.ownerName } : {}),
                    description: item.description,
                  })),
                onSelect: (id) => skills.onChange([...new Set([...skills.selectedIds, id])]),
              }
            : undefined
        }
        collections={mentionableCollections}
        integrations={
          integrations && !controlsDisabled
            ? {
                // One row per integration, already-on ones too: the mention in the
                // text names it, not an account. Picking one with nothing on turns
                // on all its accounts; the model asks which when there are several.
                items: mentionableIntegrations(integrations.items),
                onSelect: (id) => {
                  const accounts = integrations.items.filter((item) => item.integrationId === id);
                  if (accounts.some((item) => item.enabled)) return;
                  for (const item of accounts) integrations.setEnabled(item.connectionId, true);
                },
              }
            : undefined
        }
        // The field sees a paste before anything around it, so it asks first.
        onPasteData={(data) => {
          if (!target || controlsDisabled) return false;
          const files = Array.from(data.files);
          if (files.length > 0) {
            target.addFiles(files);
            return true;
          }
          // A pasted wall of text reads far better as an attachment than as a
          // draft nobody can scroll past.
          const text = data.getData("text/plain");
          if (!text || !shouldPasteAsFile(text)) return false;
          target.addFiles([createPastedTextFile(text)]);
          return true;
        }}
        value={value}
        onValueChange={onValueChange}
        onSubmit={submit}
        onCancel={onCancel}
        placeholder={noModels ? m.chat_composer_no_models() : placeholder}
        {...(textareaLabel ? { ariaLabel: textareaLabel } : {})}
        autoFocus={autoFocus}
        disabled={noModels || textareaDisabled}
      />
      {/* The textarea's own bottom padding is inside its scroll box, so the gap
          above the controls lives here: it stays constant once the text scrolls. */}
      <div className="@container flex flex-wrap items-center gap-1 p-2 pt-2">
        {target ? (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            // Any type lands in a workspace; the server upload path keeps its
            // allowlist, since the model only reads what the server accepts.
            className="sr-only"
            aria-label={m.chat_composer_attach_files()}
            // Selecting the same file twice in a row must re-fire `change`.
            onChange={(event) => {
              target.addFiles(event.target.files ?? []);
              event.target.value = "";
            }}
          />
        ) : null}
        <DropdownMenu
          onOpenChangeComplete={(open) => {
            if (open || pendingPicker === null) return;
            setPicker(pendingPicker);
            setPendingPicker(null);
          }}
        >
          <Tooltip>
            <DropdownMenuTrigger
              render={
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={menuLabel}
                      ref={setMenuAnchor}
                      disabled={
                        controlsDisabled || (!hasTools && !folders && (!target || target.isFull))
                      }
                      className="text-muted-foreground"
                    />
                  }
                />
              }
            >
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
            </DropdownMenuTrigger>
            <TooltipContent>{menuLabel}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent ref={menuPopup} align="start" className={cn(hasTools && "w-64")}>
            {target ? (
              <DropdownMenuItem onClick={pickFiles} disabled={target.isFull}>
                <HugeiconsIcon icon={Attachment01Icon} strokeWidth={2} />
                {m.chat_composer_attach_files()}
              </DropdownMenuItem>
            ) : null}
            {folders ? (
              <DropdownMenuItem
                onClick={folders.onAdd}
                disabled={controlsDisabled || folders.adding}
              >
                <HugeiconsIcon icon={FolderAddIcon} strokeWidth={2} />
                {m.chat_composer_add_folder()}
              </DropdownMenuItem>
            ) : null}
            {context && (canChooseAgent || canChooseKnowledge) ? (
              <ContextMenuItems
                selection={context.selection}
                agentLocked={context.agentLocked || !canChooseAgent}
                knowledgeEnabled={canChooseKnowledge}
                onPick={choosePicker}
                disabled={controlsDisabled}
              />
            ) : null}
            {skills && canChooseSkills ? (
              <DropdownMenuItem disabled={controlsDisabled} onClick={() => choosePicker("skills")}>
                <HugeiconsIcon icon={Book02Icon} strokeWidth={2} />
                {m.chat_composer_skills()}
                {skills.selectedIds.length > 0 ? (
                  <span className="text-muted-foreground ml-auto pl-2 text-xs tabular-nums">
                    {skills.selectedIds.length}
                  </span>
                ) : null}
              </DropdownMenuItem>
            ) : null}
            {imageModel && canChooseImageModel ? (
              <ImageModelMenu
                value={imageModel.value}
                lock={imageModel.lock}
                agentPreference={imageModel.agentPreference}
                onChange={imageModel.onChange}
                disabled={controlsDisabled}
              />
            ) : null}
            {integrations && (integrations.items.length || integrations.canAdd) ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger disabled={controlsDisabled}>
                    <HugeiconsIcon icon={PlugSocketIcon} strokeWidth={2} />
                    {m.chat_composer_integrations()}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-64">
                    {integrations.items.map((item) => (
                      <DropdownMenuSwitchItem
                        key={item.connectionId}
                        checked={item.enabled}
                        onCheckedChange={(checked) =>
                          integrations.setEnabled(item.connectionId, checked)
                        }
                      >
                        <IntegrationLogo integrationId={item.integrationId} />
                        {/* Only told apart once there is more than one of it. */}
                        {item.account && sharesIntegration(integrations.items, item)
                          ? `${item.name} · ${item.account}`
                          : item.name}
                      </DropdownMenuSwitchItem>
                    ))}
                    {integrations.items.length ? <DropdownMenuSeparator /> : null}
                    <DropdownMenuItem onClick={() => setAddingIntegration(true)}>
                      <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
                      {m.chat_composer_add_integration()}
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            ) : null}
            {canResearch && (onResearchEnabledChange || researchEnabled) ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSwitchItem
                  checked={researchEnabled}
                  onCheckedChange={(checked) => onResearchEnabledChange?.(checked)}
                  disabled={
                    modeDisabled || (!researchEnabled && researchUnavailableReason !== null)
                  }
                  {...(researchUnavailableReason ? { "aria-describedby": researchHintId } : {})}
                >
                  <HugeiconsIcon icon={GlobalSearchIcon} strokeWidth={2} />
                  {m.chat_composer_deep_research()}
                </DropdownMenuSwitchItem>
                {researchUnavailableReason ? (
                  <p id={researchHintId} className="text-muted-foreground px-2 pt-1 pb-1.5 text-xs">
                    {researchUnavailableReason}
                  </p>
                ) : null}
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        {integrations && addingIntegration ? (
          <AddIntegrationDialog open onOpenChange={setAddingIntegration} chat={integrations} />
        ) : null}
        {skills && canChooseSkills ? (
          <SkillPicker
            items={skills.items}
            selectedIds={skills.selectedIds}
            onChange={skills.onChange}
            open={picker === "skills"}
            onOpenChange={(open) => setPicker(open ? "skills" : null)}
            anchor={menuAnchor}
            side={pickerSide}
          />
        ) : null}
        {context && canChooseAgent && !context.agentLocked ? (
          <AgentPicker
            selection={context.selection}
            onAgentChange={context.onAgentChange}
            open={picker === "agent"}
            onOpenChange={(open) => setPicker(open ? "agent" : null)}
            anchor={menuAnchor}
            side={pickerSide}
          />
        ) : null}
        {context && canChooseKnowledge ? (
          <CollectionPicker
            selection={context.selection}
            agentCollectionIds={context.agentCollectionIds}
            maxCollections={context.maxCollections}
            onCollectionsChange={context.onCollectionsChange}
            open={picker === "collections"}
            onOpenChange={(open) => setPicker(open ? "collections" : null)}
            anchor={menuAnchor}
            side={pickerSide}
          />
        ) : null}
        {searchAvailable ? (
          <Button
            size="sm-collapsible"
            variant={searchEnabled ? "default" : "ghost"}
            aria-label={m.chat_composer_search_label()}
            aria-pressed={searchEnabled}
            onClick={() => onSearchEnabledChange(!searchEnabled)}
            disabled={controlsDisabled}
            className={cn("shrink-0", !searchEnabled && "text-muted-foreground")}
          >
            <HugeiconsIcon icon={GlobalSearchIcon} strokeWidth={2} data-icon="inline-start" />
            <span>{m.chat_composer_search()}</span>
          </Button>
        ) : null}
        {/* One unit, so a narrow composer wraps model, reasoning and send onto
            their own row together instead of wherever the tools run out. */}
        <div className="flex min-w-0 grow items-center gap-1">
          {/* Below when there is room, as on an empty new chat, like the plus
              menu; both flip above the composer in a conversation. */}
          <ModelPicker
            limited
            models={models}
            value={selectedModel?.id ?? null}
            onChange={onModelChange}
            side="bottom"
            disabled={noModels || controlsDisabled}
            trigger={<Button variant="chip" size="sm" className="min-w-0 max-w-64" />}
          >
            <span className="truncate text-sm">
              {selectedModel?.displayName ?? m.chat_composer_select_model()}
            </span>
          </ModelPicker>
          {onReasoningEffortChange && (selectedModel?.reasoningEfforts?.length ?? 0) > 0 ? (
            <DropdownMenu open={reasoningMenuOpen} onOpenChange={setReasoningMenuOpen}>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="chip"
                    size="sm-collapsible"
                    disabled={controlsDisabled}
                    aria-label={m.chat_effort_label({
                      effort: reasoningEffort
                        ? effortLabels[reasoningEffort]()
                        : m.chat_effort_default(),
                    })}
                  />
                }
              >
                <HugeiconsIcon icon={AiBrain01Icon} strokeWidth={2} data-icon="inline-start" />
                <span>
                  {reasoningEffort ? effortLabels[reasoningEffort]() : m.chat_effort_default()}
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuRadioGroup
                  value={reasoningEffort ?? "default"}
                  onValueChange={(chosenEffort) => {
                    onReasoningEffortChange(
                      chosenEffort === "default"
                        ? null
                        : (selectedModel?.reasoningEfforts?.find(
                            (effort) => effort === chosenEffort,
                          ) ?? null),
                    );
                    setReasoningMenuOpen(false);
                  }}
                >
                  <DropdownMenuRadioItem value="default">
                    {m.chat_effort_default()}
                  </DropdownMenuRadioItem>
                  {selectedModel?.reasoningEfforts?.map((effort) => (
                    <DropdownMenuRadioItem key={effort} value={effort}>
                      {effortLabels[effort]()}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {onStop && queueDraft ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={onStop}
                      aria-label={m.chat_composer_stop()}
                    />
                  }
                >
                  <HugeiconsIcon icon={StopIcon} strokeWidth={2} className="size-4" aria-hidden />
                </TooltipTrigger>
                <TooltipContent>{m.chat_composer_stop()}</TooltipContent>
              </Tooltip>
            ) : null}
            {onCancel ? (
              <Button size="sm" variant="ghost" onClick={onCancel} disabled={disabled}>
                {m.common_cancel()}
              </Button>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    onClick={stopping ? onStop : submit}
                    // Stop is available precisely while sending is disabled.
                    disabled={!stopping && !canSubmit}
                    aria-label={actionLabel}
                    aria-busy={(!onStop && target?.queued) || undefined}
                  />
                }
              >
                <MotionSwap value={action} kind="icon" className="size-4">
                  {stopping ? (
                    <HugeiconsIcon icon={StopIcon} strokeWidth={2} className="size-4" aria-hidden />
                  ) : target?.queued ? (
                    <Spinner aria-hidden className="size-4" />
                  ) : (
                    <HugeiconsIcon
                      icon={ArrowUp02Icon}
                      strokeWidth={2}
                      className="size-4"
                      aria-hidden
                    />
                  )}
                </MotionSwap>
              </TooltipTrigger>
              <TooltipContent>
                {actionLabel}
                {!stopping ? <Kbd>Enter</Kbd> : null}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
      <Disclosure
        open={
          (researchEnabled && (!canResearch || !!researchUnavailableReason)) || !!collectionsReason
        }
      >
        <DisclosureContent>
          <p role="status" className="text-muted-foreground px-4 pb-3 text-xs">
            {collectionsReason ??
              (!canResearch ? m.chat_composer_research_unavailable() : researchUnavailableReason)}
          </p>
        </DisclosureContent>
      </Disclosure>
      {/* Never intercept dragleave/drop; only opacity changes, not hit testing. */}
      <motion.div
        aria-hidden={!dragging}
        inert
        initial={false}
        animate={{ opacity: dragging ? 1 : 0 }}
        transition={{ duration: reduced ? 0 : 0.12 }}
        className="border-ring/70 bg-background/85 pointer-events-none absolute inset-1 z-10 grid place-items-center rounded-composer-inner border-2 border-dashed backdrop-blur-[2px]"
      >
        <span className="text-foreground flex items-center gap-2 text-sm font-medium">
          <HugeiconsIcon icon={Attachment01Icon} strokeWidth={2} className="size-4" />
          {m.chat_composer_drop_attach()}
        </span>
      </motion.div>
    </div>
  );
});
