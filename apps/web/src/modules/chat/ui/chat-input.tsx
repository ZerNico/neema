import type { SkillSummary } from "~/modules/skills/schema.ts";
import { SkillPicker } from "~/modules/skills/ui/skill-picker.tsx";
import {
  AiBrain01Icon,
  ArrowUp02Icon,
  Attachment01Icon,
  Book02Icon,
  Folder01Icon,
  GlobalSearchIcon,
  PlugSocketIcon,
  PlusSignIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { capabilitiesQuery } from "~/modules/groups/client/queries.ts";
import { forwardRef, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  chatModelsQuery,
  researchAvailabilityQuery,
  webSearchAvailabilityQuery,
} from "../client/queries.ts";
import { resolveChatModel } from "../client/selected-model.ts";
import { CHAT_INPUT_SHELL_CLASS, ChatTextarea } from "./chat-textarea.tsx";
import { ModelPicker } from "./model-picker.tsx";
import {
  AgentPicker,
  CollectionPicker,
  ContextChips,
  ContextChip,
  ReferenceChip,
  ContextMenuItems,
  MAX_SELECTED_COLLECTIONS,
  collectionStatus,
  type ContextPickerKind,
  type ComposerContext,
} from "./context-picker.tsx";
import { knowledgeCollectionsQuery } from "~/modules/knowledge/client/queries.ts";
import { ATTACHMENT_ACCEPT } from "~/modules/attachments/constants.ts";
import { documentParsingAvailabilityQuery } from "~/modules/attachments/client/queries.ts";
import {
  type AttachmentUpload,
  type AttachmentUploads,
  attachmentUrl,
  createPastedTextFile,
  shouldPasteAsFile,
} from "~/modules/attachments/client/use-attachment-uploads.ts";
import { AttachmentChip, AttachmentChipRow } from "~/modules/attachments/ui/attachment-chip.tsx";
import type { WorkspaceImports } from "~/modules/desktop/client/use-workspace-imports.ts";
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
import * as m from "motion/react-m";
import { MotionSwap, useAppReducedMotion } from "~/ui/motion.tsx";
import { Disclosure, DisclosureContent } from "~/ui/disclosure.tsx";
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";
import type { ComposerIntegrations } from "~/modules/integrations/client/use-chat-integrations.ts";
import { AddIntegrationDialog } from "~/modules/integrations/ui/add-integration-dialog.tsx";
import { IntegrationLogo } from "~/modules/integrations/ui/integration-logo.tsx";
import type { ConversationMode } from "../schema.ts";
import type { MessageReference } from "../references.ts";
import type { ReasoningEffort } from "~/modules/providers/model-config.ts";

const effortLabels: Record<ReasoningEffort, string> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

export const ChatInput = forwardRef<
  HTMLTextAreaElement,
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
    onModelChange: (modelId: string, source?: "default") => void;
    searchEnabled: boolean;
    onSearchEnabledChange: (enabled: boolean) => void;
    reasoningEffort?: ReasoningEffort | null | undefined;
    onReasoningEffortChange?: ((effort: ReasoningEffort | null) => void) | undefined;
    researchEnabled?: boolean;
    onResearchEnabledChange?: (enabled: boolean) => void;
    /**
     * Chat or Work, offered only where Work can be honoured: a new chat inside
     * the desktop app. Absent hides the toggle; an existing chat's mode is
     * fixed at creation and shown by the folder strip instead.
     */
    mode?: { value: ConversationMode; onChange: (mode: ConversationMode) => void } | undefined;
    /** Why sending is blocked right now, when it is. Shown under the row. */
    blockedReason?: string | null | undefined;
    /** Owner-held upload state; research remains available without uploads. */
    attachments?: AttachmentUploads | undefined;
    /**
     * Work chat inside the desktop app: drops and pastes become local
     * workspace files instead of server uploads. Present only there; the
     * browser keeps the upload path.
     */
    workspaceImports?: WorkspaceImports | undefined;
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
    queueLabel = "Add to queue",
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
    mode,
    blockedReason = null,
    attachments,
    workspaceImports,
    context,
    skills,
    integrations,
    references,
    placeholder = "Message…",
    textareaLabel,
    autoFocus = false,
    submitLabel = "Send",
    className,
  },
  textareaRef,
) {
  const { data: models } = useSuspenseQuery(chatModelsQuery);
  const { data: capabilities } = useQuery(capabilitiesQuery);
  const { data: searchAvailability } = useQuery(webSearchAvailabilityQuery);
  const { data: researchAvailability } = useQuery({
    ...researchAvailabilityQuery,
    enabled:
      !!capabilities?.deepResearch &&
      !!capabilities.webSearch &&
      (onResearchEnabledChange !== undefined || researchEnabled),
  });
  const researchHintId = useId();
  // Where a dropped file goes: the chat's local workspace inside the desktop
  // app, a server upload everywhere else.
  const target =
    capabilities?.work && workspaceImports
      ? workspaceImports
      : capabilities?.attachments
        ? attachments
        : undefined;
  const canChooseAgent = !!capabilities?.agentsUse;
  const canChooseKnowledge = !!capabilities?.knowledgeUse;
  const canChooseSkills = !!capabilities?.skillsUse;
  const canResearch = !!capabilities?.deepResearch && !!capabilities.webSearch;
  const modeDisabled = controlsDisabled || !!target?.queued || !onResearchEnabledChange;
  const reduced = useAppReducedMotion();
  // Queueing owns the primary button only while there is something to queue,
  // so an empty composer still offers Stop where people expect it. Files
  // dropped into a Work chat's workspace never queue: their send reserves the
  // turn, which a running answer refuses, so that draft keeps Stop instead.
  const queueDraft =
    queueing &&
    !workspaceImports?.items.length &&
    (value.trim() !== "" || (attachments?.items.length ?? 0) > 0);
  const stopping = !!onStop && !queueDraft;
  const action = stopping ? "stop" : target?.queued ? "upload" : "send";
  const actionLabel = stopping
    ? "Stop generating"
    : workspaceImports?.queued
      ? "Sending after the files land in the workspace"
      : attachments?.queued
        ? "Sending after uploads finish"
        : queueDraft
          ? queueLabel
          : submitLabel;
  // Everything the "+" menu can offer besides attaching files. Three things key
  // off this: the trigger's label, whether it's enabled, and the menu width.
  // They drifted apart when Skills was added to the menu without being added
  // to any of them, so they read it from one place now.
  const [addingIntegration, setAddingIntegration] = useState(false);
  const hasTools =
    (!!context && (canChooseKnowledge || (canChooseAgent && !context.agentLocked))) ||
    (!!skills && canChooseSkills) ||
    (canResearch && (!!onResearchEnabledChange || researchEnabled)) ||
    // Only when there is something to connect or already connected.
    !!(integrations && (integrations.items.length || integrations.canAdd));
  const menuLabel = hasTools ? "Add files or tools" : "Add attachment";
  // "#" offers the same collections the Knowledge popup does, minus the ones
  // already on this message and the agent's own (not the user's to add or
  // remove). Selecting one commits immediately, passing the full list plus
  // the single addition, exactly as the popup's Add button does.
  const knowledge = useQuery({
    ...knowledgeCollectionsQuery,
    enabled: !!context && canChooseKnowledge,
  });
  const mentionableCollections = useMemo(() => {
    if (!context || controlsDisabled || !canChooseKnowledge) return undefined;
    const selected = new Set(context.selection.collectionIds);
    if (selected.size >= MAX_SELECTED_COLLECTIONS) return undefined;
    return {
      items: (knowledge.data ?? [])
        .filter(
          (collection) =>
            !selected.has(collection.id) && !context.agentCollectionIds.has(collection.id),
        )
        .map((collection) => ({
          id: collection.id,
          label: collection.name,
          description: collection.description || collectionStatus(collection),
        })),
      onSelect: (id: string) =>
        context.onCollectionsChange([...context.selection.collectionIds, id], [id]),
    };
  }, [context, controlsDisabled, canChooseKnowledge, knowledge.data]);
  // A context row closes the menu first and opens its popup once the menu is
  // gone, anchored to the same "+" button: two overlays returning focus to
  // each other is what a submenu would have avoided and this avoids too.
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false);
  const [pendingPicker, setPendingPicker] = useState<ContextPickerKind | "skills" | null>(null);
  const [picker, setPicker] = useState<ContextPickerKind | "skills" | null>(null);
  const { data: parsingAvailability } = useQuery({
    ...documentParsingAvailabilityQuery,
    enabled: attachments !== undefined && workspaceImports === undefined,
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  // dragenter/dragleave fire for every child; a depth counter keeps the
  // highlight from flickering as the pointer crosses the textarea.
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const noModels = models.length === 0;
  const selectedModel = resolveChatModel(models, modelId);

  useEffect(() => {
    if (selectedModel && selectedModel.id !== modelId) onModelChange(selectedModel.id, "default");
  }, [modelId, onModelChange, selectedModel]);
  // Tools never depend on which model is selected: the gateway polyfills
  // prompt-based calling for models without native support. Only an empty
  // model list hides the toggle, since nothing could be sent anyway.
  const searchAvailable =
    !!capabilities?.webSearch &&
    (searchAvailability?.enabled ?? false) &&
    selectedModel !== undefined;

  const researchUnavailableReason = !researchAvailability
    ? "Checking research availability…"
    : !researchAvailability.configured || !researchAvailability.enabled
      ? "Web search and page reading must both be enabled."
      : null;

  // Parsing lets a PDF through on a model without native file input; while the
  // query is still loading we say nothing rather than flash a wrong warning.
  const parsingUsable = parsingAvailability
    ? parsingAvailability.configured && parsingAvailability.enabled
    : true;

  const warningFor = (item: AttachmentUpload): string | null => {
    if (item.status === "error") return null;
    if (item.kind === "image" && selectedModel && !selectedModel.capabilities.vision) {
      return `${selectedModel.displayName} cannot read images, so pick another model or remove this file.`;
    }
    if (
      item.kind === "pdf" &&
      selectedModel &&
      !selectedModel.capabilities.files &&
      !parsingUsable
    ) {
      return `${selectedModel.displayName} cannot read PDFs and document parsing is disabled. Ask an admin to enable it or pick another model.`;
    }
    return null;
  };

  // Stored chips preview from the authenticated route; an image still in
  // flight previews from its local object URL.
  const previewFor = (item: AttachmentUpload): string | null => {
    if (item.status === "complete" && item.attachment) return attachmentUrl(item.attachment.id);
    if (item.kind === "image") return item.previewUrl;
    return null;
  };

  const items = attachments?.items ?? [];
  const importItems = workspaceImports?.items ?? [];
  const blocked =
    items.some((item) => item.status === "error") ||
    items.some((item) => warningFor(item) !== null) ||
    importItems.some((item) => item.status === "error");
  const usable = items.filter((item) => item.status !== "error").length;
  const usableImports = importItems.filter((item) => item.status !== "error").length;
  const canSubmit =
    !disabled &&
    !!selectedModel &&
    selectedModel.id === modelId &&
    !blocked &&
    !(researchEnabled && (!canResearch || researchUnavailableReason)) &&
    !blockedReason &&
    !target?.queued &&
    (value.trim() !== "" || usable > 0 || usableImports > 0);

  const submit = () => {
    if (canSubmit) onSubmit();
  };

  const pickFiles = () => fileInputRef.current?.click();

  const acceptDrop = (event: React.DragEvent) =>
    target !== undefined && !controlsDisabled && event.dataTransfer.types.includes("Files");

  return (
    <div
      className={cn("relative", CHAT_INPUT_SHELL_CLASS, dragging && "border-ring/60", className)}
      onDragEnter={(event) => {
        if (!acceptDrop(event)) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!acceptDrop(event)) return;
        event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!acceptDrop(event)) return;
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        if (!acceptDrop(event)) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        target?.addFiles(event.dataTransfer.files);
      }}
      onPaste={(event) => {
        if (!target || controlsDisabled) return;
        const files = Array.from(event.clipboardData.files);
        if (files.length > 0) {
          event.preventDefault();
          target.addFiles(files);
          return;
        }
        // A pasted wall of text reads far better as an attachment than as a
        // draft nobody can scroll past.
        const text = event.clipboardData.getData("text/plain");
        if (text && shouldPasteAsFile(text)) {
          event.preventDefault();
          target.addFiles([createPastedTextFile(text)]);
        }
      }}
    >
      {(references && references.items.length > 0) ||
      (context?.agentSkillIds && context.agentSkillIds.size > 0) ||
      (skills && skills.selectedIds.length > 0) ||
      (attachments && items.length > 0) ||
      (workspaceImports && importItems.length > 0) ||
      (context &&
        ((context.selection.agent && !context.agentLocked) ||
          context.selection.collectionIds.length > 0)) ? (
        <AttachmentChipRow className="px-3 pt-3">
          {/* What the message is about comes first. */}
          {references?.items.map((reference) => (
            <ReferenceChip
              key={`${reference.kind}:${reference.id}`}
              reference={reference}
              onRemove={controlsDisabled ? undefined : () => references.onRemove(reference)}
            />
          ))}
          {[...(context?.agentSkillIds ?? [])]
            .filter((id) => !skills?.selectedIds.includes(id))
            .map((id) => (
              <ContextChip
                key={`agent-skill:${id}`}
                item={{
                  kind: "skill",
                  id,
                  name: skills?.items.find((skill) => skill.id === id)?.name ?? null,
                  note: "From agent",
                }}
              />
            ))}
          {skills?.selectedIds.map((id) => (
            <ContextChip
              key={`skill:${id}`}
              item={{
                kind: "skill",
                id,
                name: skills.items.find((skill) => skill.id === id)?.name ?? null,
                note: "Skill",
              }}
              onRemove={
                controlsDisabled
                  ? undefined
                  : () => skills.onChange(skills.selectedIds.filter((selected) => selected !== id))
              }
            />
          ))}
          {/* Context first: it frames the files that follow. */}
          {context ? (
            <ContextChips
              selection={context.selection}
              agentCollectionIds={context.agentCollectionIds}
              agentLocked={context.agentLocked}
              onAgentChange={context.onAgentChange}
              onCollectionsChange={context.onCollectionsChange}
              disabled={controlsDisabled}
            />
          ) : null}
          {workspaceImports
            ? importItems.map((item) => (
                <AttachmentChip
                  key={item.localId}
                  item={{ ...item, location: "workspace" }}
                  onRemove={
                    controlsDisabled ? undefined : () => workspaceImports.remove(item.localId)
                  }
                />
              ))
            : null}
          {attachments
            ? items.map((item) => (
                <AttachmentChip
                  key={item.localId}
                  item={item}
                  warning={warningFor(item)}
                  onRemove={controlsDisabled ? undefined : () => attachments.remove(item.localId)}
                  preview={previewFor(item)}
                />
              ))
            : null}
        </AttachmentChipRow>
      ) : null}
      {target?.notice ? (
        <p className="text-muted-foreground px-4 pt-2 text-xs">{target.notice}</p>
      ) : null}

      <ChatTextarea
        ref={textareaRef}
        skills={
          skills && canChooseSkills && !controlsDisabled
            ? {
                items: skills.items
                  .filter(
                    (item) =>
                      !skills.selectedIds.includes(item.id) && skills.selectedIds.length < 5,
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
                // Turns the service on if needed and names it in the message.
                // Every connected service is listed, already-on ones too.
                items: integrations.items.map((item) => ({
                  id: item.integrationId,
                  label: item.name,
                  ...(item.enabled ? { meta: "on" } : {}),
                  description: item.accountLabel,
                  search: `${item.integrationId} ${item.name}`,
                })),
                onSelect: (id) => {
                  if (!integrations.items.find((item) => item.integrationId === id)?.enabled)
                    integrations.setEnabled(id, true);
                },
                // Stays in the message, so the model knows which service is meant.
                insertText: (item) => `@${item.label} `,
              }
            : undefined
        }
        value={value}
        onValueChange={onValueChange}
        onSubmit={submit}
        onCancel={onCancel}
        placeholder={noModels ? "No models configured, ask an admin" : placeholder}
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
            {...(workspaceImports ? {} : { accept: ATTACHMENT_ACCEPT })}
            className="sr-only"
            aria-label="Attach files"
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
                      disabled={controlsDisabled || (!hasTools && (!target || target.isFull))}
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
          <DropdownMenuContent align="start" className={cn(hasTools && "w-64")}>
            {target ? (
              <DropdownMenuItem onClick={pickFiles} disabled={target.isFull}>
                <HugeiconsIcon icon={Attachment01Icon} strokeWidth={2} />
                {workspaceImports ? "Add files to the workspace" : "Attach files"}
              </DropdownMenuItem>
            ) : null}
            {context && (canChooseAgent || canChooseKnowledge) ? (
              <ContextMenuItems
                selection={context.selection}
                agentLocked={context.agentLocked || !canChooseAgent}
                knowledgeEnabled={canChooseKnowledge}
                onPick={setPendingPicker}
                disabled={controlsDisabled}
              />
            ) : null}
            {skills && canChooseSkills ? (
              <DropdownMenuItem
                disabled={controlsDisabled}
                onClick={() => setPendingPicker("skills")}
              >
                <HugeiconsIcon icon={Book02Icon} strokeWidth={2} />
                Skills
                {skills.selectedIds.length > 0 ? (
                  <span className="text-muted-foreground ml-auto pl-2 text-xs tabular-nums">
                    {skills.selectedIds.length}
                  </span>
                ) : null}
              </DropdownMenuItem>
            ) : null}
            {integrations && (integrations.items.length || integrations.canAdd) ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger disabled={controlsDisabled}>
                    <HugeiconsIcon icon={PlugSocketIcon} strokeWidth={2} />
                    Integrations
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-64">
                    {integrations.items.map((item) => (
                      <DropdownMenuSwitchItem
                        key={item.integrationId}
                        checked={item.enabled}
                        onCheckedChange={(checked) =>
                          integrations.setEnabled(item.integrationId, checked)
                        }
                      >
                        <IntegrationLogo integrationId={item.integrationId} />
                        {item.name}
                      </DropdownMenuSwitchItem>
                    ))}
                    {integrations.items.length ? <DropdownMenuSeparator /> : null}
                    <DropdownMenuItem onClick={() => setAddingIntegration(true)}>
                      <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
                      Add integration…
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
                  Deep research
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
          />
        ) : null}
        {context && canChooseAgent && !context.agentLocked ? (
          <AgentPicker
            selection={context.selection}
            onAgentChange={context.onAgentChange}
            open={picker === "agent"}
            onOpenChange={(open) => setPicker(open ? "agent" : null)}
            anchor={menuAnchor}
          />
        ) : null}
        {context && canChooseKnowledge ? (
          <CollectionPicker
            selection={context.selection}
            agentCollectionIds={context.agentCollectionIds}
            onCollectionsChange={context.onCollectionsChange}
            open={picker === "collections"}
            onOpenChange={(open) => setPicker(open ? "collections" : null)}
            anchor={menuAnchor}
          />
        ) : null}
        {mode && capabilities?.work ? (
          <ToggleGroup
            value={[mode.value]}
            onValueChange={(values) => {
              const next = values[0];
              if (next === "chat" || next === "work") mode.onChange(next);
            }}
            variant="outline"
            size="sm"
            spacing={0}
            disabled={modeDisabled}
            aria-label="Chat mode"
            className="shrink-0"
          >
            <ToggleGroupItem value="chat" aria-label="Chat">
              Chat
            </ToggleGroupItem>
            <ToggleGroupItem value="work" aria-label="Work with a folder">
              <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} data-icon="inline-start" />
              Work
            </ToggleGroupItem>
          </ToggleGroup>
        ) : null}
        {searchAvailable ? (
          <Button
            size="sm-collapsible"
            variant={searchEnabled ? "default" : "ghost"}
            aria-label="Search the web"
            aria-pressed={searchEnabled}
            onClick={() => onSearchEnabledChange(!searchEnabled)}
            disabled={controlsDisabled}
            className={cn("shrink-0", !searchEnabled && "text-muted-foreground")}
          >
            <HugeiconsIcon icon={GlobalSearchIcon} strokeWidth={2} data-icon="inline-start" />
            <span>Search</span>
          </Button>
        ) : null}
        {onReasoningEffortChange && (selectedModel?.reasoningEfforts?.length ?? 0) > 0 ? (
          <DropdownMenu open={reasoningMenuOpen} onOpenChange={setReasoningMenuOpen}>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm-collapsible"
                  disabled={controlsDisabled}
                  // oxlint-disable-next-line shadcn/no-restyle -- ghost halves its hover in dark mode, which is too faint for a chip on the composer
                  className="text-muted-foreground hover:text-foreground hover:bg-accent"
                  aria-label={`Reasoning: ${reasoningEffort ? effortLabels[reasoningEffort] : "Default"}`}
                />
              }
            >
              <HugeiconsIcon icon={AiBrain01Icon} strokeWidth={2} data-icon="inline-start" />
              <span>{reasoningEffort ? effortLabels[reasoningEffort] : "Default"}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start">
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
                <DropdownMenuRadioItem value="default">Default</DropdownMenuRadioItem>
                {selectedModel?.reasoningEfforts?.map((effort) => (
                  <DropdownMenuRadioItem key={effort} value={effort}>
                    {effortLabels[effort]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {/* One unit, so a narrow composer wraps model and send onto their own
            row together instead of wherever the tools happen to run out. */}
        <div className="flex min-w-0 grow items-center gap-1">
          <ModelPicker
            models={models}
            value={selectedModel?.id ?? null}
            onChange={onModelChange}
            disabled={noModels || controlsDisabled}
            trigger={
              <Button
                variant="ghost"
                size="sm"
                // oxlint-disable-next-line shadcn/no-restyle -- ghost halves its hover in dark mode, which is too faint for a chip on the composer
                className="text-muted-foreground hover:text-foreground hover:bg-accent min-w-0 max-w-64 gap-1.5"
              />
            }
          >
            <span className="truncate text-sm">{selectedModel?.displayName ?? "Select model"}</span>
          </ModelPicker>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {onStop && queueDraft ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={onStop}
                      aria-label="Stop generating"
                    />
                  }
                >
                  <HugeiconsIcon icon={StopIcon} strokeWidth={2} className="size-4" aria-hidden />
                </TooltipTrigger>
                <TooltipContent>Stop generating</TooltipContent>
              </Tooltip>
            ) : null}
            {onCancel ? (
              <Button size="sm" variant="ghost" onClick={onCancel} disabled={disabled}>
                Cancel
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
        open={(researchEnabled && (!canResearch || !!researchUnavailableReason)) || !!blockedReason}
      >
        <DisclosureContent>
          <p role="status" className="text-muted-foreground px-4 pb-3 text-xs">
            {blockedReason ??
              (!canResearch
                ? "Deep research isn’t available for your account."
                : researchUnavailableReason)}
          </p>
        </DisclosureContent>
      </Disclosure>
      {/* Never intercept dragleave/drop; only opacity changes, not hit testing. */}
      <m.div
        aria-hidden={!dragging}
        inert
        initial={false}
        animate={{ opacity: dragging ? 1 : 0 }}
        transition={{ duration: reduced ? 0 : 0.12 }}
        className="border-ring/70 bg-background/85 pointer-events-none absolute inset-1 z-10 grid place-items-center rounded-composer-inner border-2 border-dashed backdrop-blur-[2px]"
      >
        <span className="text-foreground flex items-center gap-2 text-sm font-medium">
          <HugeiconsIcon icon={Attachment01Icon} strokeWidth={2} className="size-4" />
          {workspaceImports ? "Drop files to add them to the workspace" : "Drop files to attach"}
        </span>
      </m.div>
    </div>
  );
});
