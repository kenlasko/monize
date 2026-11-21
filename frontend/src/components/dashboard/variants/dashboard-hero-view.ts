import type { ReactNode } from 'react';
import type { ScheduledKind } from '@/lib/scheduled-kind';

/**
 * The next scheduled occurrence, for the Modern hero's "next up" card: the
 * first of `upcomingOccurrences` over every active schedule, so it is always
 * the occurrence the Upcoming Bills widget lists first under "All upcoming".
 */
export interface HeroNextUp {
  id: string;
  name: string;
  payee: string | null;
  manual: boolean;
  kind: ScheduledKind;
  /** The occurrence's effective amount; `null` when it cannot be worked out. */
  amount: number | null;
  currencyCode: string;
  when: 'overdue' | 'today' | 'tomorrow' | 'later';
  /** `YYYY-MM-DD`. */
  dueDate: string;
}

/** What `DashboardHero` hands the frame a style draws around the sets. */
export interface DashboardHeroFrameProps {
  /** The page header: greeting, date, Customize. */
  header: ReactNode;
  /** Measures the greeting row (the Standard frame lifts the chart beside it). */
  headRef: (node: HTMLDivElement | null) => void;
  headSize: { width: number; height: number };
  /** The dots that choose a set, when there is more than one. */
  cycleControls: ReactNode;
  /** The sets side by side on their sliding track. */
  track: ReactNode;
  nextUp: HeroNextUp | null;
}
