'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { usePreferencesStore } from '@/store/preferencesStore';
import { userSettingsApi } from '@/lib/user-settings';
import { getErrorMessage } from '@/lib/errors';
import {
  layoutReducer,
  layoutsEqual,
  resolveDashboardLayout,
  serializeDashboardLayout,
  type DashboardLayout,
  type DashboardLayoutAction,
} from '@/components/dashboard/dashboard-layout';

/** The marker on the history entry edit mode pushes, so Back can tell whose entry it popped. */
const HISTORY_MARKER = 'dashboardEdit';

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
      if (!state.draft) return state;
      const draft = layoutReducer(state.draft, event.action);
      return draft === state.draft ? state : { ...state, draft };
    }
    case 'saving':
      return { ...state, saving: event.value };
    case 'confirm':
      return state.editing ? { ...state, confirmingLeave: event.value } : state;
  }
}

function pushEditEntry() {
  window.history.pushState({ ...window.history.state, [HISTORY_MARKER]: true }, '');
}

/**
 * Pop edit mode's own entry, and only that: a `Modal` entry above it spreads
 * the marker too. Says whether it popped, so the popstate it causes is skipped.
 */
function popEditEntry(): boolean {
  const state = window.history.state as Record<string, unknown> | null;
  if (state?.[HISTORY_MARKER] !== true || state.modal === true) return false;
  window.history.back();
  return true;
}

/** True while a dialog (Add widget, Hero settings, the discard prompt) is open on top. */
function dialogIsOpen() {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

/**
 * Dashboard edit mode: the draft layout and the one place a layout is written.
 *
 * Nothing reaches the server until `save` (DASH-4, DASH-5). Entering seeds the
 * draft from the stored layout and pushes a history entry, as a `Modal` with
 * `pushHistory` does, so Back on a phone leaves edit mode rather than the page.
 * Cancel, Escape and Back leave without saving; with a changed draft they ask
 * first (`confirmingLeave`).
 */
export function useDashboardLayoutDraft() {
  const t = useTranslations('dashboard');
  const [state, send] = useReducer(draftReducer, IDLE);
  const editingRef = useRef(false);
  const savingRef = useRef(false);
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
    pushEditEntry();
    send({ type: 'enter', seed: resolveDashboardLayout(prefs?.dashboardWidgets, prefs?.dashboardWidgetConfig) });
  }, []);

  /** Leave edit mode, storing nothing. */
  const discard = useCallback(() => {
    if (!editingRef.current) return;
    editingRef.current = false;
    if (popEditEntry()) ownPopsRef.current += 1;
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

  const draft = state.draft;
  const save = useCallback(async () => {
    if (!editingRef.current || savingRef.current || !draft || draft.length === 0) return;
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
      if (popEditEntry()) ownPopsRef.current += 1;
      send({ type: 'leave' });
    } catch (error) {
      toast.error(getErrorMessage(error, t('customize.toasts.saveFailed')));
      send({ type: 'saving', value: false });
      send({ type: 'confirm', value: false });
    } finally {
      savingRef.current = false;
    }
  }, [draft, t]);

  // Back: the entry edit mode pushed is gone. A changed draft puts the entry
  // back and asks, as `Modal` re-pushes when `onBeforeClose` refuses.
  useEffect(() => {
    const onPopstate = (event: PopStateEvent) => {
      if (ownPopsRef.current > 0) {
        ownPopsRef.current -= 1;
        return;
      }
      if (!editingRef.current) return;
      const landed = event.state as Record<string, unknown> | null;
      if (landed?.[HISTORY_MARKER] === true) return;
      if (dirtyRef.current) {
        pushEditEntry();
        send({ type: 'confirm', value: true });
        return;
      }
      editingRef.current = false;
      send({ type: 'leave' });
    };
    window.addEventListener('popstate', onPopstate);
    return () => window.removeEventListener('popstate', onPopstate);
  }, []);

  // Escape leaves, unless a dialog on top is the one Escape is closing.
  useEffect(() => {
    if (!state.editing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || dialogIsOpen()) return;
      cancel();
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
