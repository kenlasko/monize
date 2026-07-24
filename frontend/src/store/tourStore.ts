import { create } from 'zustand';
import { createLogger } from '@/lib/logger';
import { toursApi } from '@/lib/tours-api';
import type {
  TourDefinition,
  TourProgressMap,
  TourStatus,
  TourStep,
} from '@/lib/tours/types';

const logger = createLogger('Tours');

/**
 * Per-step lifecycle phase:
 *  - navigating     the engine is (or may be) routing to the step's screen
 *  - waiting-anchor the route is settled; waiting for the anchor to mount
 *  - active         the anchor is found (or the step is centered); tooltip shown
 *  - missing        the anchor never appeared; the step is being skipped
 */
export type TourPhase = 'navigating' | 'waiting-anchor' | 'active' | 'missing';

interface ActiveTour {
  tour: TourDefinition;
  /** Steps after start-time filtering (skipOnMobile). */
  steps: readonly TourStep[];
  stepIndex: number;
  phase: TourPhase;
  /** Count of steps skipped because their anchor never appeared. */
  skippedCount: number;
  /** Terminal generic card shown when any step was skipped, so the tour never
   *  vanishes without explanation. */
  showSkippedOutro: boolean;
  /** Pathname the engine last pushed to; a matching change is expected, not a
   *  user-initiated dismissal. */
  expectedRoute: string | null;
}

interface TourState {
  active: ActiveTour | null;
  progress: TourProgressMap;
  progressLoaded: boolean;

  setProgress: (progress: TourProgressMap) => void;
  markProgress: (tourId: string, status: TourStatus) => void;
  clearProgress: () => void;

  startTour: (tour: TourDefinition) => void;
  next: () => void;
  back: () => void;
  /** Graceful skip: the current step's anchor never appeared. */
  skip: () => void;
  /** Advance the "Done" affordance: may show the skipped outro before completing. */
  finish: () => void;
  endTour: (reason: TourStatus) => void;
  setPhase: (phase: TourPhase) => void;
  setExpectedRoute: (route: string | null) => void;
}

/** True on viewports narrower than the `sm` breakpoint (640px). */
function isMobileViewport(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return !window.matchMedia('(min-width: 640px)').matches;
}

/** Steps that survive start-time mobile filtering. */
function filterSteps(
  steps: readonly TourStep[],
  mobile: boolean,
): readonly TourStep[] {
  if (!mobile) return steps;
  return steps.filter((step) => !step.skipOnMobile);
}

export const useTourStore = create<TourState>((set, get) => ({
  active: null,
  progress: {},
  progressLoaded: false,

  setProgress: (progress) => set({ progress, progressLoaded: true }),

  markProgress: (tourId, status) => {
    set((state) => ({
      progress: {
        ...state.progress,
        [tourId]: { status, updatedAt: new Date().toISOString() },
      },
    }));
    // Optimistic + fire-and-forget: a failed save never blocks the UI.
    toursApi.saveProgress(tourId, status).catch(logger.debug);
  },

  clearProgress: () => set({ progress: {} }),

  startTour: (tour) => {
    const steps = filterSteps(tour.steps, isMobileViewport());
    if (steps.length === 0) return;
    set({
      active: {
        tour,
        steps,
        stepIndex: 0,
        phase: 'navigating',
        skippedCount: 0,
        showSkippedOutro: false,
        expectedRoute: null,
      },
    });
  },

  next: () => {
    const { active } = get();
    if (!active || active.showSkippedOutro) return;
    if (active.stepIndex >= active.steps.length - 1) return;
    set({
      active: {
        ...active,
        stepIndex: active.stepIndex + 1,
        phase: 'navigating',
        expectedRoute: null,
      },
    });
  },

  back: () => {
    const { active } = get();
    if (!active || active.showSkippedOutro) return;
    if (active.stepIndex === 0) return;
    set({
      active: {
        ...active,
        stepIndex: active.stepIndex - 1,
        phase: 'navigating',
        expectedRoute: null,
      },
    });
  },

  skip: () => {
    const { active } = get();
    if (!active || active.showSkippedOutro) return;
    const skippedCount = active.skippedCount + 1;
    if (active.stepIndex >= active.steps.length - 1) {
      // Skipped the final step: fall through to the outro/complete decision.
      set({ active: { ...active, skippedCount } });
      get().finish();
      return;
    }
    set({
      active: {
        ...active,
        skippedCount,
        stepIndex: active.stepIndex + 1,
        phase: 'navigating',
        expectedRoute: null,
      },
    });
  },

  finish: () => {
    const { active } = get();
    if (!active) return;
    if (active.skippedCount > 0 && !active.showSkippedOutro) {
      // Some steps were skipped: show a generic "tour finished" card so the
      // degradation stays visible instead of the tour vanishing.
      set({ active: { ...active, showSkippedOutro: true, phase: 'active' } });
      return;
    }
    get().endTour('completed');
  },

  endTour: (reason) => {
    const { active } = get();
    if (!active) return;
    get().markProgress(active.tour.id, reason);
    set({ active: null });
  },

  setPhase: (phase) => {
    const { active } = get();
    if (!active) return;
    set({ active: { ...active, phase } });
  },

  setExpectedRoute: (route) => {
    const { active } = get();
    if (!active) return;
    set({ active: { ...active, expectedRoute: route } });
  },
}));
