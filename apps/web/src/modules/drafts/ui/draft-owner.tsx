import type { IconSvgElement } from "@hugeicons/react";
import { useBlocker } from "@tanstack/react-router";
import {
  type FunctionComponent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useDetailPanel,
  useDetailPanelReconciler,
  useDetailPanelSelectedId,
} from "~/ui/detail-panel-context.ts";
import { ErrorState, FormActions, ListSkeleton } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { SaveLabel, SaveStatus } from "~/ui/save-status.tsx";
import { useSaveStatus } from "~/ui/use-save-status.ts";
import { Button } from "~/ui/primitives/button";
import { FieldError } from "~/ui/primitives/field";
import { useConfirm } from "~/ui/confirm-context.ts";
import { m } from "~/paraglide/messages.js";
import type { DraftKind } from "../draft-schema.ts";
import type { DraftController } from "../client/use-draft.ts";
import { scopes, type DraftPanelEntry } from "./draft-panel-context.ts";

export interface DraftHandle {
  /** Every mounted draft, so one unresolved conflict still blocks a send. */
  flush: () => Promise<boolean>;
}
interface Session {
  entry: DraftPanelEntry;
  flush: () => Promise<boolean>;
}

/**
 * What one kind of draft brings to the shared owner: its controller hook, the
 * fields it edits, the words the panel uses, and where a saved target lives.
 */
export interface DraftKindUi<S extends Record<string, unknown>> {
  kind: DraftKind;
  useController: (draftId: string) => DraftController<S>;
  /** The transcript widget's icon, repeated on the panel tab. */
  icon: IconSvgElement;
  /** Each field's name, as a message so it reads in the page's language. */
  labels: Record<keyof S & string, () => string>;
  /** The `withForm` component for this kind's settings. */
  Fields: FunctionComponent<{ form: DraftController<S>["form"] }>;
  /** The saved target's own page. */
  targetLink: (targetId: string) => ReactNode;
  /** Extra actions beside Save once a target exists, if any. */
  targetActions?: (targetId: string) => ReactNode;
  /** Every line that names the kind, one message each, since German inflects the noun. */
  copy: {
    saving: () => string;
    saved: () => string;
    untitled: () => string;
    title: () => string;
    loadFailed: () => string;
    loading: () => string;
    create: () => string;
    reloadTitle: () => string;
    reloadDescription: () => string;
    reload: () => string;
    discardSavedDescription: () => string;
    saveEffect: () => string;
    createEffect: () => string;
  };
}

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
  autoOpenIds,
  children,
  ref,
}: {
  ui: DraftKindUi<S>;
  draftIds: ReadonlyArray<string>;
  /** The server says this draft no longer exists, so stop listing it. */
  onGone: (draftId: string) => void;
  /** Drafts the answer being watched just created; their panel opens by itself. */
  autoOpenIds?: ReadonlySet<string> | undefined;
  children: ReactNode;
  ref?: Ref<DraftHandle> | undefined;
}) {
  const [sessions, setSessions] = useState<ReadonlyMap<string, Session>>(new Map());
  useDetailPanelReconciler(`${ui.kind}-draft:`, draftIds);
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
          autoOpen={autoOpenIds?.has(draftId) ?? false}
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
  autoOpen,
}: {
  ui: DraftKindUi<S>;
  draftId: string;
  publish: (draftId: string, session: Session) => void;
  forget: (draftId: string) => void;
  onGone: (draftId: string) => void;
  autoOpen: boolean;
}) {
  // oxlint-disable-next-line react/hooks -- each kind passes one module-level ui, so the hook never changes
  const controller = ui.useController(draftId);
  const panel = useDetailPanel();
  const selected = useDetailPanelSelectedId();
  const id = `${ui.kind}-draft:${draftId}`;
  useBlocker({
    shouldBlockFn: async () => controller.unpersisted() && !(await controller.flush()),
    enableBeforeUnload: controller.unpersisted,
  });
  // Resting states only, in the transcript widget:
  // autosave runs on every pause in typing, and narrating it ("pending",
  // "keeping…") flickers faster than anyone can read. Failures still surface
  // through the form's own error line.
  const status = controller.saving
    ? ui.copy.saving()
    : isSaved(controller)
      ? ui.copy.saved()
      : m.drafts_status_draft();
  const name = (controller.values.name as string) || ui.copy.untitled();
  const request = useMemo(
    () => ({
      id,
      // The title names the draft: several can exist and the panel shows one.
      // No status line in the panel: the save button says it, like the editor
      // page's (disabled once saved, with the "Saved" flash), and the
      // transcript widget names it.
      title: controller.draft ? name : ui.copy.title(),
      icon: ui.icon,
      restorable: true,
      actions: <DraftActions ui={ui} controller={controller} formId={formId(id)} />,
      body: <DraftBody ui={ui} controller={controller} formId={formId(id)} />,
    }),
    [controller, id, name, ui],
  );
  useEffect(() => {
    panel.refresh(request);
  }, [panel, request]);
  useEffect(() => () => panel.release(id), [id, panel]);
  const available = controller.draft !== null;
  // Opens the panel once, when a draft this answer just created has loaded.
  // Only live ones are passed in, so reloads and old chats never pop a panel.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!autoOpen || autoOpened.current || !available) return;
    autoOpened.current = true;
    panel.open(request);
  }, [autoOpen, available, panel, request]);
  const failed = controller.query.isError || controller.query.data === null;
  const summary = useMemo(
    () => ({
      name: available ? name : null,
      status: !available
        ? failed
          ? m.drafts_status_load_failed()
          : m.drafts_status_loading()
        : controller.error
          ? m.drafts_status_review()
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
  // A layout effect, so the button never paints its idle label in between.
  const wasSaved = useRef(saved);
  useLayoutEffect(() => {
    if (saved && !wasSaved.current) markSaved();
    wasSaved.current = saved;
  }, [markSaved, saved]);
  const draft = controller.draft;
  if (!draft) return null;
  const target = draft.targetId;
  // One row, in the editor page's order (the flash, other actions, the save
  // last), with what saving does beside it, below it when the panel is narrow.
  return (
    <div className="space-y-2">
      <FormActions className="justify-end">
        <p className="text-muted-foreground min-w-40 flex-1 text-xs">
          {target ? ui.copy.saveEffect() : ui.copy.createEffect()}
        </p>
        <SaveStatus justSaved={justSaved} />
        {target ? ui.targetActions?.(target) : null}
        <PendingButton
          type="submit"
          form={id}
          size="sm"
          pending={controller.saving}
          disabled={controller.reloading || controller.conflicts.length > 0 || saved}
        >
          <SaveLabel justSaved={justSaved}>
            {target ? m.common_save_changes() : ui.copy.create()}
          </SaveLabel>
        </PendingButton>
      </FormActions>
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
        <ErrorState title={ui.copy.loadFailed()} onRetry={() => void controller.query.refetch()} />
      );
    return <ListSkeleton rows={3} media="none" label={ui.copy.loading()} />;
  }
  const target = draft.targetId;
  const saved = isSaved(controller);
  const name = (controller.values.name as string) || ui.copy.untitled();
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
          aria-label={m.drafts_conflict_label({ field: ui.labels[key]() })}
        >
          <p className="text-sm font-medium">
            {m.drafts_conflict_title({ field: ui.labels[key]() })}
          </p>
          <p className="text-muted-foreground text-xs">{m.drafts_conflict_description()}</p>
          <pre className="bg-muted max-h-32 overflow-auto rounded-xl p-2 text-xs whitespace-pre-wrap">
            {displayValue(draft.settings[key])}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => controller.resolve(key, "local")}>
              {m.drafts_conflict_keep_mine({ field: ui.labels[key]().toLowerCase() })}
            </Button>
            <Button size="sm" variant="outline" onClick={() => controller.resolve(key, "remote")}>
              {m.drafts_conflict_use_current({ field: ui.labels[key]().toLowerCase() })}
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
                  title: ui.copy.reloadTitle(),
                  description: ui.copy.reloadDescription(),
                  confirmLabel: ui.copy.reload(),
                  destructive: true,
                }).then((confirmed) => {
                  if (confirmed) void controller.reload();
                });
              }}
            >
              {ui.copy.reload()}
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
                title: m.drafts_discard_title({ name }),
                description: target
                  ? ui.copy.discardSavedDescription()
                  : m.drafts_discard_unsaved_description(),
                confirmLabel: m.drafts_discard(),
                destructive: true,
              }).then((confirmed) => confirmed && controller.discard())
            }
          >
            {m.drafts_discard()}
          </Button>
        </div>
      )}
    </form>
  );
}
function displayValue(value: unknown) {
  if (value === null) return m.drafts_value_no_preference();
  if (value === "") return m.drafts_value_blank();
  if (typeof value === "boolean") return value ? m.drafts_value_on() : m.drafts_value_off();
  if (Array.isArray(value)) return value.length ? value.join("\n") : m.drafts_value_none();
  return String(value);
}
