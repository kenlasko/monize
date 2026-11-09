'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  DASHBOARD_HERO_SETS,
  type DashboardHeroSet,
  type DashboardHeroSetChoice,
} from './widget-config';

/** How long one set stays on screen in Auto. */
export const HERO_CYCLE_MS = 60_000;
/**
 * When Auto mounts the set off screen, counted from the first set having
 * loaded: halfway to the first slide, so it arrives drawn, and well clear of
 * the first paint and the price refresh that follows it.
 */
export const HERO_PRELOAD_MS = 30_000;

interface UseHeroCycleOptions {
  choice: DashboardHeroSetChoice;
  hasInvestments: boolean;
  /** The page's first load is over: the set on screen has what it asked for. */
  settled: boolean;
}

interface HeroCycle {
  /** The sets on the track, in order; one when there is nothing to slide to. */
  sets: readonly DashboardHeroSet[];
  active: DashboardHeroSet;
  /** Auto is alternating the sets: the set changes on its own every minute. */
  cycling: boolean;
  /** Mounted so far: what is on screen, was shown, or is being readied. */
  mounted: ReadonlySet<DashboardHeroSet>;
  /** False until the first change, so a page settling into place does not slide. */
  animate: boolean;
  goTo: (set: DashboardHeroSet) => void;
}

/**
 * Which set the hero shows. `auto` alternates every minute where the reader has
 * investments; a chosen set stays. A reader can move to the other set at any
 * time, in either mode, and that holds until the page is reloaded or the next
 * Auto change, which is a full minute away because the timer restarts on every
 * change of set.
 */
export function useHeroCycle({ choice, hasInvestments, settled }: UseHeroCycleOptions): HeroCycle {
  const home: DashboardHeroSet = choice === 'auto' ? 'netWorth' : choice;
  const [view, setView] = useState<DashboardHeroSet | null>(null);
  const [visited, setVisited] = useState<ReadonlySet<DashboardHeroSet>>(new Set());
  const [animate, setAnimate] = useState(false);
  const [preloaded, setPreloaded] = useState(false);

  // A change in Customize starts again from what was chosen.
  const [prevChoice, setPrevChoice] = useState(choice);
  if (prevChoice !== choice) {
    setPrevChoice(choice);
    setView(null);
    setAnimate(false);
  }

  const sets = hasInvestments ? DASHBOARD_HERO_SETS : ([home] as const);
  const wanted = view ?? home;
  const active = sets.includes(wanted) ? wanted : sets[0];
  const canCycle = choice === 'auto' && sets.length > 1;

  const goTo = useCallback((set: DashboardHeroSet) => {
    setVisited((prev) => new Set(prev).add(set));
    setAnimate(true);
    setView(set);
  }, []);

  useEffect(() => {
    if (!canCycle) return;
    const id = setInterval(() => {
      // A hidden tab keeps its place, and the reader comes back to what they left.
      if (document.visibilityState === 'hidden') return;
      goTo(active === 'netWorth' ? 'portfolio' : 'netWorth');
    }, HERO_CYCLE_MS);
    return () => clearInterval(id);
  }, [canCycle, active, goTo]);

  useEffect(() => {
    if (!canCycle || !settled) return;
    const id = setTimeout(() => setPreloaded(true), HERO_PRELOAD_MS);
    return () => clearTimeout(id);
  }, [canCycle, settled]);

  const mounted = new Set<DashboardHeroSet>([active, ...visited]);
  if (preloaded && canCycle) sets.forEach((set) => mounted.add(set));

  return { sets, active, cycling: canCycle, mounted, animate, goTo };
}
