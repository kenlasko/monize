import type { TourAnchorId } from './anchors';

/** App areas a tour belongs to, used for grouping and the offer-row label. */
export type TourArea =
  | 'intro'
  | 'transactions'
  | 'accounts'
  | 'budgets'
  | 'reports'
  | 'settings';

/**
 * How a step advances to the next one.
 * - `next`     passive: the user clicks Next (the default).
 * - `click`    interactive: advance when the user clicks the highlighted anchor.
 *              A click that triggers navigation must use `route`, not this.
 * - `appear`   advance when a target element appears (e.g. a form opens).
 * - `disappear` advance when a target goes away (e.g. the user closes a form).
 * - `route`    advance when the pathname changes (optionally matching a prefix).
 */
export type TourAdvance =
  | { type: 'next' }
  | { type: 'click' }
  | { type: 'appear'; anchorId: TourAnchorId }
  | { type: 'disappear'; anchorId: TourAnchorId }
  | { type: 'route'; route?: string };

export type TourPlacement = 'top' | 'bottom' | 'left' | 'right' | 'auto';

export interface TourStep {
  /** i18n leaf: tours.<i18nPrefix>.steps.<id>.{title,body}. */
  id: string;
  /** The engine navigates here first if the current route differs. */
  route: string;
  /** Prefix match for dynamic routes (e.g. '/accounts/' matches '/accounts/<id>'). */
  routeMatch?: string;
  /** null = centered welcome/outro card with no anchor. */
  anchorId: TourAnchorId | null;
  /** Defaults to { type: 'next' }. */
  advance?: TourAdvance;
  placement?: TourPlacement;
  /** Filtered out at startTour on narrow viewports. */
  skipOnMobile?: boolean;
  /**
   * How long to wait for the anchor before gracefully skipping the step.
   * Defaults to 5000ms; the engine uses 10000ms for the first anchor after a
   * navigation so cold route loads on slow connections do not eat steps.
   */
  anchorTimeoutMs?: number;
}

export interface TourDefinition {
  /** Persistence key ('intro/basics', 'release-1.13.0/accounts'). Never rename. */
  id: string;
  area: TourArea;
  /** Minor line for release tours ('1.13'); undefined for evergreen tours. */
  version?: string;
  /** i18n prefix under the `tours` namespace (e.g. 'intro.basics'). */
  i18nPrefix: string;
  steps: readonly TourStep[];
}

/** Terminal states persisted for a tour. */
export type TourStatus = 'completed' | 'dismissed';

export interface TourProgressEntry {
  status: TourStatus;
  version?: string;
  updatedAt: string;
}

export type TourProgressMap = Record<string, TourProgressEntry>;
