import { useBlocker } from "@tanstack/react-router";
import {
  type Context,
  type FunctionComponent,
  type ReactNode,
  type Ref,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useDetailPanel, useDetailPanelSelectedId } from "~/ui/detail-panel.tsx";
import { ErrorState, FormActions, ListSkeleton } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { SaveLabel, SaveStatus, useSaveStatus } from "~/ui/save-status.tsx";
import { Button } from "~/ui/primitives/button";
import { FieldError } from "~/ui/primitives/field";
import { useConfirm } from "~/ui/confirm.tsx";
import type { DraftKind } from "../draft-schema.ts";
import type { DraftController } from "../client/use-draft.ts";

export interface DraftHandle {
  /** Every mounted draft, so one unresolved conflict still blocks a send. */
  flush: () => Promise<boolean>;
}
export interface DraftPanelEntry {
  name: string | null;
  status: string;
  expanded: boolean;
  open: (() => void) | null;
  retry: (() => void) | null;
}
interface Session {
  entry: DraftPanelEntry;
  flush: () => Promise<boolean>;
}
// Transcript references get only an opener and an authorized summary, never a form copy.
interface DraftPanelScope {
  /** Drafts this conversation owns; a branch-copied reference is absent. */
  owned: ReadonlySet<string>;
  entries: ReadonlyMap<string, DraftPanelEntry>;
}

/**
 * What one kind of draft brings to the shared owner: its controller hook, the
 * fields it edits, the words the panel uses, and where a saved target lives.
 */
export interface DraftKindUi<S extends Record<string, unknown>> {
  kind: DraftKind;
  useController: (draftId: string) => DraftController<S>;
  /** "agent", "schedule": the noun in labels and confirmations. */
  noun: string;
  /** Capitalised for titles: "Agent draft", "Create agent". */
  Noun: string;
  labels: Record<keyof S & string, string>;
  /** The `withForm` component for this kind's settings. */
  Fields: FunctionComponent<{ form: DraftController<S>["form"] }>;
  /** The saved target's own page. */
  targetLink: (targetId: string) => ReactNode;
  /** Extra actions beside Save once a target exists, if any. */
  targetActions?: (targetId: string) => ReactNode;
  copy: {
    saveEffect: string;
    createEffect: string;
  };
}

// One context per kind, so an agent widget and a schedule widget in the same
// chat each read their own owner, and both can nest without shadowing.
const emptyScope: DraftPanelScope = { owned: new Set(), entries: new Map() };
const scopes: Record<DraftKind, Context<DraftPanelScope>> = {
  agent: createContext(emptyScope),
  schedule: createContext(emptyScope),
};
export const useDraftPanel = (kind: DraftKind, draftId: string) => {
  const scope = useContext(scopes[kind]);
  return { owned: scope.owned.has(draftId), entry: scope.entries.get(draftId) ?? null };
};

/**
 * Saved to the target with nothing edited since, so the draft holds no work
 * of its own. The panel subtitle and the footer both turn on this.
 */
const isSaved = <S extends Record<string, unknown>>(controller: DraftController<S>) =>
  controller.draft !== null &&
  controller.draft.savedDraftRevision === controller.draft.revision &&
  !controller.dirty;

/**
 * One controller per draft, all mounted here at conversation level rather than
 * in the transcript, so a widget scrolling out of the virtualiser cannot take
 * unsaved edits with it.
 */
export function DraftOwner<S extends Record<string, unknown>>({
  ui,
  draftIds,
  onGone,
  children,
  ref,
}: {
  ui: DraftKindUi<S>;
  draftIds: ReadonlyArray<string>;
  /** The server says this draft no longer exists, so stop listing it. */
  onGone: (draftId: string) => void;
  children: ReactNode;
  ref?: Ref<DraftHandle> | undefined;
}) {
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
  const Scope = scopes[ui.kind];
  return (
    <>
      {draftIds.map((draftId) => (
        <DraftSession
          key={draftId}
          ui={ui}
          draftId={draftId}
          publish={publish}
          forget={forget}
          onGone={onGone}
        />
      ))}
      <Scope value={value}>{children}</Scope>
    </>
  );
}

function DraftSession<S extends Record<string, unknown>>({
  ui,
  draftId,
  publish,
  forget,
  onGone,
}: {
  ui: DraftKindUi<S>;
  draftId: string;
  publish: (draftId: string, session: Session) => void;
  forget: (draftId: string) => void;
  onGone: (draftId: string) => void;
}) {
  const controller = ui.useController(draftId);
  const panel = useDetailPanel();
  const selected = useDetailPanelSelectedId();
  const id = `${ui.kind}-draft:${draftId}`;
  useBlocker({
    shouldBlockFn: async () => controller.unpersisted() && !(await controller.flush()),
    enableBeforeUnload: controller.unpersisted,
  });
  // Resting states only, in the panel subtitle as in the transcript widget:
  // autosave runs on every pause in typing, and narrating it ("pending",
  // "keeping…") flickers faster than anyone can read. Failures still surface
  // through the form's own error line.
  const status = controller.saving
    ? `Saving ${ui.noun}…`
    : isSaved(controller)
      ? `${ui.Noun} saved`
      : "Draft";
  const name = (controller.values.name as string) || `Untitled ${ui.noun}`;
  const request = useMemo(
    () => ({
      id,
      // The title names the draft: several can exist and the panel shows one.
      title: controller.draft ? name : `${ui.Noun} draft`,
      subtitle: status,
      actions: <DraftActions ui={ui} controller={controller} formId={formId(id)} />,
      body: <DraftBody ui={ui} controller={controller} formId={formId(id)} />,
    }),
    [controller, id, name, status, ui],
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
    [available, controller.error, controller.query, failed, id, name, panel, request, selected, status],
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

/** The form lives in the scroller, so its submit reaches it by id from outside. */
const formId = (panelId: string) => `${panelId}-form`;

function DraftActions<S extends Record<string, unknown>>({
  ui,
  controller,
  formId: id,
}: {
  ui: DraftKindUi<S>;
  controller: DraftController<S>;
  formId: string;
}) {
  const saved = isSaved(controller);
  const { justSaved, markSaved } = useSaveStatus();
  // The save runs in the controller; the moment it lands is when "saved" turns on.
  const wasSaved = useRef(saved);
  useEffect(() => {
    if (saved && !wasSaved.current) markSaved();
    wasSaved.current = saved;
  }, [markSaved, saved]);
  const draft = controller.draft;
  if (!draft) return null;
  const target = draft.targetId;
  return (
    <div className="space-y-2">
      <FormActions>
        <PendingButton
          type="submit"
          form={id}
          size="sm"
          pending={controller.saving}
          disabled={controller.reloading || controller.conflicts.length > 0 || saved}
        >
          <SaveLabel justSaved={justSaved}>
            {target ? "Save changes" : `Create ${ui.noun}`}
          </SaveLabel>
        </PendingButton>
        <SaveStatus justSaved={justSaved} />
        {target ? ui.targetActions?.(target) : null}
      </FormActions>
      <p className="text-muted-foreground text-xs">
        {target ? ui.copy.saveEffect : ui.copy.createEffect}
      </p>
      {controller.error ? <FieldError>{controller.error}</FieldError> : null}
    </div>
  );
}

function DraftBody<S extends Record<string, unknown>>({
  ui,
  controller,
  formId: id,
}: {
  ui: DraftKindUi<S>;
  controller: DraftController<S>;
  formId: string;
}) {
  const { draft, form } = controller;
  const confirm = useConfirm();
  if (!draft) {
    if (controller.query.isError || controller.query.data === null)
      return (
        <ErrorState
          title={`Could not load the ${ui.noun} draft`}
          onRetry={() => void controller.query.refetch()}
        />
      );
    return <ListSkeleton rows={3} media="none" label={`Loading ${ui.noun} draft`} />;
  }
  const target = draft.targetId;
  const saved = isSaved(controller);
  const name = (controller.values.name as string) || `Untitled ${ui.noun}`;
  return (
    <form
      id={id}
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void controller.save();
      }}
    >
      {controller.conflicts.map((key) => (
        <section
          key={key}
          className="space-y-2 rounded-2xl border p-3"
          aria-label={`${ui.labels[key]} conflict`}
        >
          <p className="text-sm font-medium">{ui.labels[key]} changed in another edit</p>
          <p className="text-muted-foreground text-xs">
            Your value stays in the field. The current draft has
          </p>
          <pre className="bg-muted max-h-32 overflow-auto rounded-xl p-2 text-xs whitespace-pre-wrap">
            {displayValue(draft.settings[key])}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => controller.resolve(key, "local")}>
              Keep my {ui.labels[key].toLowerCase()}
            </Button>
            <Button size="sm" variant="outline" onClick={() => controller.resolve(key, "remote")}>
              Use current {ui.labels[key].toLowerCase()}
            </Button>
          </div>
        </section>
      ))}
      <fieldset disabled={controller.reloading} className="flex min-w-0 flex-col gap-6">
        <ui.Fields form={form} />
      </fieldset>
      {target ? (
        <div className="space-y-2 border-t pt-3">
          <FormActions>
            {ui.targetLink(target)}
            <PendingButton
              size="sm"
              variant="outline"
              pending={controller.reloading}
              disabled={controller.saving}
              onClick={() => {
                // Reload resets the form to the target's settings, so a draft
                // holding edits of its own loses them. A saved draft matches
                // the target already and has nothing to ask about.
                if (saved) {
                  void controller.reload();
                  return;
                }
                void confirm({
                  title: `Reload from the saved ${ui.noun}?`,
                  description: `The edits in this draft are replaced by the ${ui.noun}’s current settings.`,
                  confirmLabel: `Reload ${ui.noun}`,
                  destructive: true,
                }).then((confirmed) => {
                  if (confirmed) void controller.reload();
                });
              }}
            >
              Reload {ui.noun}
            </PendingButton>
          </FormActions>
        </div>
      ) : null}
      {/* A saved draft holds no work of its own, so there is nothing to throw
          away; it goes with the conversation, which cascades to its drafts. */}
      {saved ? null : (
        <div className="flex justify-end border-t pt-3">
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() =>
              void confirm({
                title: `Discard "${name}"?`,
                description: target
                  ? `The draft is removed from this chat. The saved ${ui.noun} itself is not affected.`
                  : "The draft is removed from this chat. Nothing was saved, so it cannot be recovered.",
                confirmLabel: "Discard draft",
                destructive: true,
              }).then((confirmed) => confirmed && controller.discard())
            }
          >
            Discard draft
          </Button>
        </div>
      )}
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
