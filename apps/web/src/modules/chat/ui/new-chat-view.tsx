import { m } from "~/paraglide/messages.js";
import { Folder01Icon, IncognitoIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AnimatePresence } from "motion/react";
import * as motion from "motion/react-m";
import { useEffect, useRef, useState } from "react";
import { uuidv7 } from "uuidv7";
import { desktopAttemptFields } from "~/modules/desktop/client/bridge.ts";
import { useChatIntegrations } from "~/modules/integrations/client/use-chat-integrations.ts";
import { projectQuery } from "~/modules/projects/client/queries.ts";
import { toastError } from "~/ui/error-toast.ts";
import { chatModelsQuery } from "../client/queries.ts";
import { HeaderContent } from "~/ui/header-slot.tsx";
import { MotionSwap } from "~/ui/motion.tsx";
import { motionEase } from "~/ui/motion-presets.ts";
import { Button } from "~/ui/primitives/button";
import { Toggle } from "~/ui/primitives/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { prefersReducedMotion, useAppReducedMotion } from "~/ui/reduced-motion.ts";
import { useIsMobile } from "~/ui/use-mobile.ts";
import { cn } from "~/ui/utils";
import { browserTimeZone } from "../client/time-zone.ts";
import { sendMessage } from "../server/functions.ts";
import { agentIcon } from "./agent-icons.ts";
import { Composer, type ComposerHandle } from "./composer.tsx";
import { greetingFor } from "./greeting.ts";
import { useContextSelection } from "./use-context-selection.ts";
import { useReasoningEffort } from "./use-reasoning-effort.ts";
import { useModelChoice } from "../client/use-model-choice.ts";
import { useSearchMode } from "./use-search-mode.ts";

/**
 * How long the composer takes to travel from the middle of the column down to
 * the bottom. Navigation waits this out, so a fast first response cannot swap
 * the route in mid-slide, which would read as a jump rather than a move.
 */
const SLIDE_MS = 380;

export function NewChatView({
  user,
  initialAgentId = null,
  initialSkillId = null,
  initialPrefill = null,
  onPrefillConsumed,
  temporary = false,
  onTemporaryChange,
  projectId = null,
}: {
  user: { name: string };
  /** Starts the chat as temporary; the route keeps it in the address. */
  temporary?: boolean;
  /** Starts the chat inside this project; never temporary. */
  projectId?: string | null;
  onTemporaryChange?: (temporary: boolean) => void;
  /** Pre-selected from an agent page; sent as an explicit install. */
  initialAgentId?: string | null;
  initialSkillId?: string | null;
  initialPrefill?: string | null;
  onPrefillConsumed?: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Fixed per visit so the line doesn't change while you type.
  const [greetingMoment] = useState(() => ({ now: new Date(), roll: Math.random() }));
  // Null leaves the first answer to pick: the agent's image model, else the admin's first.
  const [imageModelId, setImageModelId] = useState<string | null>(null);
  const context = useContextSelection({
    mode: "draft",
    agent: initialAgentId ? { id: initialAgentId, name: null } : null,
  });
  const selectedAgent = context.detail;
  const {
    enabled: searchEnabled,
    setEnabled: setSearchEnabled,
    reset: resetSearchEnabled,
  } = useSearchMode(selectedAgent.data?.searchEnabled ?? true);
  // A chosen agent suggests its own model; a pick wins until the agent changes.
  const agentModel = selectedAgent.data?.model?.available ? selectedAgent.data.model.id : null;
  const { modelId, pick: pickModel } = useModelChoice(agentModel);
  const { effort: reasoningEffort, setEffort: setReasoningEffort } = useReasoningEffort(modelId);
  const starters = selectedAgent.data?.starters ?? [];
  const composer = useRef<ComposerHandle>(null);
  // Fixed per visit, so a retried first send names the same chat.
  const [conversationId] = useState(uuidv7);
  // Held locally until the first message creates the chat and carries them.
  const integrations = useChatIntegrations(null);
  const isMobile = useIsMobile();
  useEffect(() => {
    if (initialPrefill) composer.current?.prefillDraft(initialPrefill);
    onPrefillConsumed?.();
  }, [initialPrefill, onPrefillConsumed]);
  useEffect(() => {
    // matchMedia is read directly as well: `useIsMobile` reports "not mobile"
    // wherever it is missing, and a phone must not raise the keyboard.
    if (!isMobile && !window.matchMedia?.("(max-width: 767px)").matches) composer.current?.focus();
  }, [isMobile]);
  // Flipped the moment the first message actually leaves: the composer drops
  // into the position it occupies in ChatView, so the route swap that follows
  // lands on geometry that already matches.
  const [sending, setSending] = useState(false);
  // Resolves when the slide is over. A ref because the mutation callbacks that
  // await it are created once, not per render.
  const slide = useRef<Promise<void>>(Promise.resolve());

  const sendMutation = useMutation({
    mutationFn: async (input: {
      content: string;
      attachmentIds: ReadonlyArray<string>;
      researchEnabled: boolean;
      skillIds?: ReadonlyArray<string>;
    }) =>
      sendMessage({
        data: {
          conversation: {
            kind: "new" as const,
            id: conversationId,
            ...(temporary && !projectId ? { temporary: true } : {}),
            ...(projectId ? { projectId } : {}),
          },
          modelId: modelId!,
          ...(imageModelId ? { imageModelId } : {}),
          content: input.content,
          searchEnabled,
          reasoningEffort,
          timeZone: browserTimeZone(),
          attachmentIds: input.attachmentIds,
          researchEnabled: input.researchEnabled,
          skillIds: [...(input.skillIds ?? [])],
          ...context.sendFields,
          ...integrations.sendFields,
          ...(await desktopAttemptFields()),
        },
      }),
    // Fires when the request starts, i.e. after any queued upload settled.
    // the composer should not move while it is still waiting on those.
    onMutate: () => {
      setSending(true);
      slide.current = prefersReducedMotion()
        ? Promise.resolve()
        : new Promise((resolve) => setTimeout(resolve, SLIDE_MS));
    },
    // The draft and its chips survive a failure, so the composer travels back
    // up to where the user left it.
    onError: (error) => {
      setSending(false);
      toastError(m.chat_send_failed(), error);
      void queryClient.invalidateQueries({ queryKey: chatModelsQuery.queryKey });
    },
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
        slide.current,
      ]);
      await navigate({
        to: "/chat/$conversationId",
        params: { conversationId: result.conversationId },
        state: { anchorNewTurn: true },
      });
    },
  });

  // A project chat is never temporary: the project lists it.
  const offerTemporary = !!onTemporaryChange && !projectId;
  const project = useQuery({ ...projectQuery(projectId ?? ""), enabled: !!projectId });
  const isTemporary = offerTemporary && temporary;
  const reducedMotion = useAppReducedMotion();

  return (
    <div className="flex h-full flex-col">
      {offerTemporary ? (
        <HeaderContent>
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  size="icon"
                  variant="solid"
                  className="ml-auto"
                  aria-label={m.chat_temporary_label()}
                  pressed={temporary}
                  onPressedChange={onTemporaryChange}
                />
              }
            >
              {/* Keyed on the state, so each switch replays a small pop. */}
              <motion.span
                key={String(temporary)}
                className="flex"
                initial={reducedMotion ? false : { scale: 0.6, rotate: temporary ? -12 : 12 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: "spring", stiffness: 520, damping: 20 }}
              >
                <HugeiconsIcon icon={IncognitoIcon} strokeWidth={2} aria-hidden />
              </motion.span>
            </TooltipTrigger>
            <TooltipContent>
              {temporary ? m.chat_temporary_turn_off() : m.chat_temporary_start()}
            </TooltipContent>
          </Tooltip>
        </HeaderContent>
      ) : null}
      {/* Anchored to the bottom of its share of the column, so the greeting
          keeps its distance from the composer while both travel down. */}
      <div className="flex min-h-0 flex-1 flex-col justify-end px-4 pb-6">
        <div
          className={cn(
            "flex flex-col items-center text-center transition-all duration-200 ease-out motion-reduce:transition-none",
            sending ? "translate-y-1 opacity-0" : "translate-y-0 opacity-100",
          )}
        >
          {selectedAgent.data ? (
            // An agent chat announces itself: the agent, not the greeting,
            // is what the first message goes to.
            <>
              <span className="bg-muted text-muted-foreground mb-3 grid size-12 place-items-center rounded-2xl">
                <HugeiconsIcon
                  icon={agentIcon(selectedAgent.data.icon)}
                  strokeWidth={2}
                  className="size-6"
                  aria-hidden
                />
              </span>
              <h1 className="text-foreground text-2xl font-medium">{selectedAgent.data.name}</h1>
              {selectedAgent.data.description ? (
                <p className="text-muted-foreground mt-1 max-w-md text-sm">
                  {selectedAgent.data.description}
                </p>
              ) : null}
            </>
          ) : (
            <h1 className="text-foreground text-2xl font-medium tracking-tight">
              <MotionSwap value={isTemporary ? "temporary" : "greeting"}>
                {isTemporary
                  ? m.chat_temporary_title()
                  : greetingFor(user.name, greetingMoment.now, greetingMoment.roll)}
              </MotionSwap>
            </h1>
          )}
          {projectId && project.data ? (
            <Link
              to="/projects/$projectId"
              params={{ projectId }}
              className="text-muted-foreground hover:text-foreground mt-2 flex items-center gap-1.5 text-sm"
            >
              <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} className="size-4" aria-hidden />
              {m.chat_new_in_project({ project: project.data.name })}
            </Link>
          ) : null}
          <AnimatePresence initial={false}>
            {isTemporary ? (
              <motion.div
                key="temporary"
                className="overflow-hidden"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: reducedMotion ? 0 : 0.18, ease: motionEase }}
              >
                <p className="text-muted-foreground max-w-md pt-2 text-sm">
                  {m.chat_temporary_description()}
                </p>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
        {starters.length > 0 && !sending ? (
          <ul
            aria-label={m.chat_starters_label()}
            className="mx-auto mt-6 flex w-full max-w-3xl flex-wrap justify-center gap-2"
          >
            {starters.map((starter) => (
              <li key={starter}>
                <Button
                  size="sm"
                  variant="outline"
                  className="max-w-72"
                  onClick={() => composer.current?.seedDraft(starter)}
                >
                  <span className="truncate">{starter}</span>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {/* Mirrors ChatView's composer wrapper exactly: same scrollbar gutter,
          max width and bottom padding, so the slide ends on the next route's
          resting position instead of near it. */}
      <div className="pb-4 [scrollbar-gutter:stable_both-edges]">
        <div className="mx-auto w-full max-w-3xl px-4">
          <Composer
            initialSkillId={initialSkillId}
            integrations={integrations}
            onSend={(content, attachmentIds, researchEnabled, skillIds) =>
              sendMutation.mutateAsync({
                content,
                attachmentIds,
                researchEnabled,
                ...(skillIds ? { skillIds } : {}),
              })
            }
            disabled={sendMutation.isPending}
            modelId={modelId}
            onModelChange={pickModel}
            searchEnabled={searchEnabled}
            onSearchEnabledChange={setSearchEnabled}
            reasoningEffort={reasoningEffort}
            onReasoningEffortChange={setReasoningEffort}
            imageModel={{
              value: imageModelId,
              agentPreference: selectedAgent.data?.imageModelId,
              onChange: setImageModelId,
            }}
            context={{
              ...context,
              onAgentChange: (id) => {
                // Picking another agent starts from that agent's defaults again.
                pickModel(null);
                resetSearchEnabled();
                context.onAgentChange(id);
              },
            }}
            ref={composer}
          />
        </div>
      </div>
      {/* An equal share with the block above is what centres the composer;
          collapsing it to nothing is what carries the composer down.
          `flex-grow` is an animatable number, so this is one cheap property
          transition rather than a measured layout animation. */}
      <div
        className="min-h-0 basis-0 transition-[flex-grow] ease-in-out motion-reduce:transition-none"
        style={{ flexGrow: sending ? 0 : 1, transitionDuration: `${SLIDE_MS}ms` }}
      />
    </div>
  );
}
