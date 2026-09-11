import { Link, useBlocker } from "@tanstack/react-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { useAgentDraft } from "../client/use-agent-draft.ts";
import type { DraftField } from "../client/draft-reconciliation.ts";
import { AgentSettingsFields } from "./agent-settings-fields.tsx";
import { useDetailPanel, useDetailPanelSelectedId } from "~/ui/detail-panel.tsx";
import { ErrorState, FormActions, ListSkeleton } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button, buttonVariants } from "~/ui/primitives/button";
import { FieldError } from "~/ui/primitives/field";
import { useConfirm } from "~/ui/confirm.tsx";

export interface AgentDraftHandle {
  /** Every mounted draft, so one unresolved conflict still blocks a send. */
  flush: () => Promise<boolean>;
}
interface AgentDraftOwnerProps {
  draftIds: ReadonlyArray<string>;
  /** The server says this draft no longer exists, so stop listing it. */
  onGone: (draftId: string) => void;
  children: ReactNode;
  ref?: Ref<AgentDraftHandle> | undefined;
}
interface Session {
  entry: DraftPanelEntry;
  flush: () => Promise<boolean>;
}
interface DraftPanelEntry {
  name: string | null;
  status: string;
  expanded: boolean;
  open: (() => void) | null;
  retry: (() => void) | null;
}

// Transcript references get only an opener and an authorized summary, never a form copy.
interface DraftPanelScope {
  /** Drafts this conversation owns; a branch-copied reference is absent. */
  owned: ReadonlySet<string>;
  entries: ReadonlyMap<string, DraftPanelEntry>;
}
const AgentDraftPanelContext = createContext<DraftPanelScope>({
  owned: new Set(),
  entries: new Map(),
});
export const useAgentDraftPanel = (draftId: string) => {
  const scope = useContext(AgentDraftPanelContext);
  return { owned: scope.owned.has(draftId), entry: scope.entries.get(draftId) ?? null };
};

/**
 * One controller per draft, all mounted here at conversation level rather than
 * in the transcript, so a widget scrolling out of the virtualiser cannot take
 * unsaved edits with it.
 */
export function AgentDraftOwner({ draftIds, onGone, children, ref }: AgentDraftOwnerProps) {
  const [sessions, setSessions] = useState<ReadonlyMap<string, Session>>(new Map());
  // The controller is a fresh object each render, so a session publishes on every
  // commit. Only a visible change may set state, or the two re-render each other
  // forever. A skipped update leaves a stale `open`, which self-corrects when the
  // panel refreshes its body.
  const publish = useCallback(
    (draftId: string, session: Session) =>
      setSessions((current) => {
        const previous = current.get(draftId)?.entry;
        return previous &&
          previous.name === session.entry.name &&
          previous.status === session.entry.status &&
          previous.expanded === session.entry.expanded &&
          !previous.open === !session.entry.open &&
          !previous.retry === !session.entry.retry
          ? current
          : new Map(current).set(draftId, session);
      }),
    [],
  );
  const forget = useCallback(
    (draftId: string) =>
      setSessions((current) => {
        const next = new Map(current);
        next.delete(draftId);
        return next;
      }),
    [],
  );
  useImperativeHandle(
    ref,
    () => ({
      flush: async () => {
        // Sequential on purpose: each drain serialises against its own queue,
        // and a partial failure must still leave the others flushed.
        let ready = true;
        for (const session of sessions.values()) ready = (await session.flush()) && ready;
        return ready;
      },
    }),
    [sessions],
  );
  const value = useMemo(
    () => ({
      owned: new Set(draftIds),
      entries: new Map([...sessions].map(([draftId, session]) => [draftId, session.entry])),
    }),
    [draftIds, sessions],
  );
  return (
    <>
      {draftIds.map((draftId) => (
        <AgentDraftSession
          key={draftId}
          draftId={draftId}
          publish={publish}
          forget={forget}
          onGone={onGone}
        />
      ))}
      <AgentDraftPanelContext value={value}>{children}</AgentDraftPanelContext>
    </>
  );
}
const labels: Record<DraftField, string> = {
  name: "Name",
  description: "Description",
  instructions: "Instructions",
  icon: "Icon",
  modelId: "Preferred model",
  searchEnabled: "Web search",
  planEnabled: "Working checklist",
  starters: "Conversation starters",
  collectionIds: "Collections",
  skillIds: "Skills",
};

function AgentDraftSession({
  draftId,
  publish,
  forget,
  onGone,
}: {
  draftId: string;
  publish: (draftId: string, session: Session) => void;
  forget: (draftId: string) => void;
  onGone: (draftId: string) => void;
}) {
  const controller = useAgentDraft(draftId);
  const panel = useDetailPanel();
  const selected = useDetailPanelSelectedId();
  const id = `agent-draft:${draftId}`;
  useBlocker({
    shouldBlockFn: async () => controller.unpersisted() && !(await controller.flush()),
    enableBeforeUnload: controller.unpersisted,
  });
  // Resting states only, in the panel subtitle as in the transcript widget:
  // autosave runs on every pause in typing, and narrating it ("pending",
  // "keeping…") flickers faster than anyone can read. Failures still surface
  // through the form's own error line.
  const saved =
    controller.draft !== null &&
    controller.draft.savedDraftRevision === controller.draft.revision &&
    !controller.dirty;
  const status = controller.saving ? "Saving agent…" : saved ? "Agent saved" : "Draft";
  const name = controller.values.name || "Untitled agent";
  const request = useMemo(
    () => ({
      id,
      // The title names the draft: several can exist and the panel shows one.
      title: controller.draft ? name : "Agent draft",
      subtitle: status,
      body: <AgentDraftBody controller={controller} />,
    }),
    [controller, id, name, status],
  );
  useEffect(() => {
    panel.refresh(request);
  }, [panel, request]);
  useEffect(() => () => panel.closeIfSelected(id), [id, panel]);
  const available = controller.draft !== null;
  const failed = controller.query.isError || controller.query.data === null;
  const summary = useMemo(
    () => ({
      name: available ? name : null,
      status: !available
        ? failed
          ? "Could not load draft"
          : "Loading draft…"
        : controller.error
          ? "Review changes"
          : status,
      expanded: selected === id,
      open: available ? () => panel.open(request) : null,
      retry: failed
        ? () => {
            void controller.query.refetch();
          }
        : null,
    }),
    [
      available,
      controller.error,
      controller.query,
      failed,
      id,
      name,
      panel,
      request,
      selected,
      status,
    ],
  );
  const flush = controller.flush;
  useEffect(() => {
    publish(draftId, { entry: summary, flush });
  }, [draftId, flush, publish, summary]);
  useEffect(() => () => forget(draftId), [draftId, forget]);
  // A fetch that resolves to null means discarded or cascaded away, which is
  // not a load failure and must not leave a dead widget behind.
  const gone = controller.query.isSuccess && controller.query.data === null;
  useEffect(() => {
    if (gone) onGone(draftId);
  }, [draftId, gone, onGone]);
  return null;
}

function AgentDraftBody({ controller }: { controller: ReturnType<typeof useAgentDraft> }) {
  const { draft, form } = controller;
  const confirm = useConfirm();
  if (!draft) {
    if (controller.query.isError || controller.query.data === null)
      return (
        <ErrorState
          title="Could not load the agent draft"
          onRetry={() => void controller.query.refetch()}
        />
      );
    return <ListSkeleton rows={3} media="none" label="Loading agent draft" />;
  }
  const target = draft.targetAgentId;
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void controller.save();
      }}
    >
      {/* Pulled into the body's top padding so it keeps that breathing room
          once stuck instead of pressing against the panel header. */}
      <div className="bg-background sticky top-0 z-10 -mt-4 space-y-2 border-b pt-4 pb-3">
        <FormActions>
          <PendingButton
            type="submit"
            size="sm"
            pending={controller.saving}
            disabled={controller.reloading || controller.conflicts.length > 0}
          >
            {target ? "Save changes" : "Create agent"}
          </PendingButton>
          {target ? (
            <Link
              to="/"
              search={{ agent: target }}
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              Start chat
            </Link>
          ) : null}
        </FormActions>
        <p className="text-muted-foreground text-xs">
          {target
            ? "Saving changes affects future replies in chats using this agent."
            : "The agent is created only when you choose Create agent."}
        </p>
        {controller.error ? <FieldError>{controller.error}</FieldError> : null}
      </div>
      {controller.conflicts.map((key) => (
        <section
          key={key}
          className="space-y-2 rounded-2xl border p-3"
          aria-label={`${labels[key]} conflict`}
        >
          <p className="text-sm font-medium">{labels[key]} changed in another edit</p>
          <p className="text-muted-foreground text-xs">
            Your value stays in the field. The current draft has
          </p>
          <pre className="bg-muted max-h-32 overflow-auto rounded-xl p-2 text-xs whitespace-pre-wrap">
            {displayValue(draft.settings[key])}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => controller.resolve(key, "local")}>
              Keep my {labels[key].toLowerCase()}
            </Button>
            <Button size="sm" variant="outline" onClick={() => controller.resolve(key, "remote")}>
              Use current {labels[key].toLowerCase()}
            </Button>
          </div>
        </section>
      ))}
      <fieldset disabled={controller.reloading} className="flex min-w-0 flex-col gap-6">
        <AgentSettingsFields form={form} />
      </fieldset>
      <div className="flex justify-end border-t pt-3">
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={() =>
            void confirm({
              title: `Discard "${controller.values.name || "Untitled agent"}"?`,
              description: target
                ? "The draft is removed from this chat. The saved agent itself is not affected."
                : "The draft is removed from this chat. Nothing was saved, so it cannot be recovered.",
              confirmLabel: "Discard draft",
              destructive: true,
            }).then((confirmed) => confirmed && controller.discard())
          }
        >
          Discard draft
        </Button>
      </div>
      {target ? (
        <div className="space-y-2 border-t pt-3">
          <Link
            to="/agents/$agentId"
            params={{ agentId: target }}
            className="text-sm underline underline-offset-2"
          >
            View agent in the editor
          </Link>
          <p className="text-muted-foreground text-xs">
            Reloading replaces this working draft with the current agent.
          </p>
          <PendingButton
            size="sm"
            variant="outline"
            pending={controller.reloading}
            disabled={controller.saving}
            onClick={() => void controller.reload()}
          >
            Reload agent
          </PendingButton>
        </div>
      ) : null}
    </form>
  );
}
function displayValue(value: unknown) {
  if (value === null) return "No preference";
  if (value === "") return "(blank)";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (Array.isArray(value)) return value.length ? value.join("\n") : "(none)";
  return String(value);
}
