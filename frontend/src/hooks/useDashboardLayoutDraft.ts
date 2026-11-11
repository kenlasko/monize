'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { usePreferencesStore } from '@/store/preferencesStore';
import { userSettingsApi } from '@/lib/user-settings';
import { getErrorMessage } from '@/lib/errors';
import { newClientId } from '@/lib/client-id';
import { afterModalHistoryPop } from '@/lib/after-modal-history-pop';
import {
  layoutReducer,
  layoutsEqual,
  resolveDashboardLayout,
  serializeDashboardLayout,
  type DashboardLayout,
  type DashboardLayoutAction,
} from '@/components/dashboard/dashboard-layout';

/**
 * The key on the history entry edit mode pushes. Its value is a random id of
 * this visit (an identifier, not a secret), so an entry an earlier visit left behind (section 10.3) is not taken
 * for this visit's.
 */
const HISTORY_MARKER = 'dashboardEdit';

/** Panels with an Escape of their own: dialogs, the AI sheet, the docked help panel. */
const OWN_ESCAPE_SELECTOR = '[role="dialog"], [role="complementary"], [aria-modal="true"]';

interface DraftState {
  editing: boolean;
  /** The layout the draft was seeded from; `dirty` compares against it. */
  seed: DashboardLayout | null;
  draft: DashboardLayout | null;
  saving: boolean;
  /** The discard prompt is up, asked by Cancel, Escape or Back with a changed draft. */
  confirmingLeave: boolean;
}

type DraftEvent =
  | { type: 'enter'; seed: DashboardLayout }
  | { type: 'leave' }
  | { type: 'layout'; action: DashboardLayoutAction }
  | { type: 'saving'; value: boolean }
  | { type: 'confirm'; value: boolean };

const IDLE: DraftState = { editing: false, seed: null, draft: null, saving: false, confirmingLeave: false };

function draftReducer(state: DraftState, event: DraftEvent): DraftState {
  switch (event.type) {
    case 'enter':
      return state.editing ? state : { ...IDLE, editing: true, seed: event.seed, draft: event.seed };
    case 'leave':
      return IDLE;
    case 'layout': {
      // A save in flight stores the draft Done was pressed on and then leaves,
      // so an edit made now would be dropped with it: none is taken.
      if (!state.draft || state.saving) return state;
      const draft = layoutReducer(state.draft, event.action);
      return draft === state.draft ? state : { ...state, draft };
    }
    case 'saving':
      return { ...state, saving: event.value };
    case 'confirm':
      return state.editing ? { ...state, confirmingLeave: event.value } : state;
  }
}

function currentEntry() {
  return window.history.state as Record<string, unknown> | null;
}

function pushEditEntry(visitId: string) {
  window.history.pushState({ ...window.history.state, [HISTORY_MARKER]: visitId }, '');
}

/**
 * Pop this visit's entry, and only that: a `Modal` entry above it spreads the
 * same id too. Says whether it popped, so the popstate it causes is skipped.
 */
function popEditEntry(visitId: string): boolean {
  const state = currentEntry();
  if (state?.[HISTORY_MARKER] !== visitId || state.modal === true) return false;
  window.history.back();
  return true;
}

/**
 * Escape is edit mode's unless a modal dialog is open (Add widget, Hero
 * settings, the discard prompt), or it was typed in a panel that answers
 * Escape itself. Scoped by the key's target rather than by focus being in the
 * dashboard, because focus on the page body (after a click on empty space) is
 * the dashboard's too.
 */
function escapeIsEditModes(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented) return false;
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return false;
  return !(event.target instanceof Element && event.target.closest(OWN_ESCAPE_SELECTOR));
}

/**
 * Dashboard edit mode: the draft layout and the one place a layout is written.
 *
 * Nothing reaches the server until `save` (DASH-4, DASH-5). Entering seeds the
 * draft from the stored layout and pushes a history entry, as a `Modal` with
 * `pushHistory` does, so Back on a phone leaves edit mode rather than the page.
 * Cancel, Escape and Back leave without saving; with a changed draft they ask
 * first (`confirmingLeave`). Done with nothing changed leaves as a discard
 * does. While a save is in flight nothing else leaves: the save does.
 */
export function useDashboardLayoutDraft() {
  const t = useTranslations('dashboard');
  const [state, send] = useReducer(draftReducer, IDLE);
  const editingRef = useRef(false);
  const savingRef = useRef(false);
  // This visit's id, carried by the history entry it pushed.
  const visitIdRef = useRef('');
  // Popstates our own `history.back()` will cause; they arrive asynchronously,
  // possibly after the reader has already entered edit mode again.
  const ownPopsRef = useRef(0);
  const dirty = !!state.seed && !!state.draft && !layoutsEqual(state.seed, state.draft);
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const enter = useCallback(() => {
    if (editingRef.current) return;
    const prefs = usePreferencesStore.getState().preferences;
    editingRef.current = true;
    visitIdRef.current = newClientId();
    pushEditEntry(visitIdRef.current);
    send({ type: 'enter', seed: resolveDashboardLayout(prefs?.dashboardWidgets, prefs?.dashboardWidgetConfig) });
  }, []);

  /** Leave edit mode, storing nothing. Not mid-save: the save leaves when it lands. */
  const discard = useCallback(() => {
    if (!editingRef.current || savingRef.current) return;
    editingRef.current = false;
    if (popEditEntry(visitIdRef.current)) ownPopsRef.current += 1;
    send({ type: 'leave' });
  }, []);

  /** Cancel, Escape: leave at once when nothing changed, otherwise ask. Not mid-save. */
  const cancel = useCallback(() => {
    if (!editingRef.current || savingRef.current) return;
    if (dirtyRef.current) send({ type: 'confirm', value: true });
    else discard();
  }, [discard]);

  const keepEditing = useCallback(() => send({ type: 'confirm', value: false }), []);

  const dispatch = useCallback((action: DashboardLayoutAction) => send({ type: 'layout', action }), []);

  const { seed, draft } = state;
  const save = useCallback(async () => {
    if (!editingRef.current || savingRef.current || !draft) return;
    // Done with nothing changed is a discard: no request to store what is stored.
    if (!seed || layoutsEqual(seed, draft)) {
      discard();
      return;
    }
    if (draft.length === 0) return;
    savingRef.current = true;
    send({ type: 'saving', value: true });
    try {
      // The settings map is read now, not when the draft was seeded, so a
      // widget setting changed meanwhile is kept (DASH-6).
      const configNow = usePreferencesStore.getState().preferences?.dashboardWidgetConfig;
      const saved = await userSettingsApi.updatePreferences(serializeDashboardLayout(draft, configNow));
      usePreferencesStore.getState().updatePreferences({
        dashboardWidgets: saved.dashboardWidgets,
        dashboardWidgetConfig: saved.dashboardWidgetConfig,
      });
      editingRef.current = false;
      if (popEditEntry(visitIdRef.current)) ownPopsRef.current += 1;
      send({ type: 'leave' });
    } catch (error) {
      toast.error(getErrorMessage(error, t('customize.toasts.saveFailed')));
      send({ type: 'saving', value: false });
      send({ type: 'confirm', value: false });
    } finally {
      savingRef.current = false;
    }
  }, [seed, draft, discard, t]);

  // Back: the entry edit mode pushed is gone. A changed draft puts the entry
  // back and asks, as `Modal` re-pushes when `onBeforeClose` refuses.
  useEffect(() => {
    const onPopstate = (event: PopStateEvent) => {
      if (ownPopsRef.current > 0) {
        ownPopsRef.current -= 1;
        return;
      }
      if (!editingRef.current) return;
      // Landing on this visit's entry means only a dialog above it closed.
      const landed = event.state as Record<string, unknown> | null;
      if (landed?.[HISTORY_MARKER] === visitIdRef.current) return;
      // Mid-save, put the entry back and wait: the save leaves (and pops it)
      // when it lands, or stays in edit mode if it is refused.
      if (savingRef.current) {
        pushEditEntry(visitIdRef.current);
        return;
      }
      if (dirtyRef.current) {
        pushEditEntry(visitIdRef.current);
        send({ type: 'confirm', value: true });
        return;
      }
      editingRef.current = false;
      send({ type: 'leave' });
    };
    window.addEventListener('popstate', onPopstate);
    return () => window.removeEventListener('popstate', onPopstate);
  }, []);

  // Unmounted while editing: pop edit mode's entry, as a `Modal` with
  // `pushHistory` does on unmount, but only while it is still the current
  // entry. After a link's navigation the router has already pushed the next
  // page's entry over it, and a back() would undo that navigation, so the
  // stale entry is left. Deferred so a Strict Mode replay, which mounts again
  // at once, pops nothing.
  const lifetimeRef = useRef<symbol | null>(null);
  useEffect(() => {
    const lifetime = Symbol();
    lifetimeRef.current = lifetime;
    return () => {
      queueMicrotask(() => {
        if (lifetimeRef.current !== lifetime || !editingRef.current) return;
        editingRef.current = false;
        const visitId = visitIdRef.current;
        const top = currentEntry();
        // A dialog's entry is over ours, and that Modal pops it as it unmounts
        // too. Its back() lands later, so ours is the current entry only then.
        if (top?.[HISTORY_MARKER] === visitId && top.modal === true) {
          afterModalHistoryPop(() => popEditEntry(visitId));
          return;
        }
        popEditEntry(visitId);
      });
    };
  }, []);

  // Escape leaves, unless a dialog on top or a panel of its own is the one
  // Escape is closing.
  useEffect(() => {
    if (!state.editing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (escapeIsEditModes(event)) cancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [state.editing, cancel]);

  return {
    editing: state.editing,
    draft: state.draft,
    dirty,
    saving: state.saving,
    confirmingLeave: state.confirmingLeave,
    enter,
    cancel,
    discard,
    keepEditing,
    dispatch,
    save,
  };
}

export type DashboardLayoutDraft = ReturnType<typeof useDashboardLayoutDraft>;
