/**
 * Semantic color for a row action. The tone -- not a raw Tailwind class -- is what
 * callers choose, so every list uses the same color for the same verb.
 */
export type ActionTone =
  | 'primary' // blue   -- edit, reopen
  | 'view' // emerald -- view/open a linked record
  | 'delete' // red    -- destructive
  | 'success' // green  -- reconcile, post, reactivate
  | 'warning' // orange -- close, skip, deactivate
  | 'accent' // purple -- merge, schedule recurring
  | 'neutral'; // gray  -- duplicate, filters, secondary

/** Key into the shared inline-SVG icon set (see ActionIcon.tsx). */
export type ActionIconKey =
  | 'edit'
  | 'view'
  | 'delete'
  | 'duplicate'
  | 'merge'
  | 'reconcile'
  | 'post'
  | 'skip'
  | 'close'
  | 'reopen'
  | 'reactivate'
  | 'schedule'
  | 'deactivate'
  | 'activate'
  | 'favorite'
  | 'prices'
  | 'history'
  | 'transactions'
  | 'filter';

/**
 * A single per-row action. Callers build these from already-translated labels and
 * their own handlers; the shared renderers (`RowActions`, `RowActionSheet`) turn
 * them into consistent buttons.
 */
export interface RowAction {
  /** Stable identity for React keys. */
  key: string;
  /** Already-translated label (also the default tooltip / aria-label). */
  label: string;
  /** Which icon to show in icon-only (compact/dense) mode and in the action sheet. */
  icon: ActionIconKey;
  /** Semantic color. */
  tone: ActionTone;
  onClick: () => void;
  /** When true, the action is omitted entirely. */
  hidden?: boolean;
  /** When true, the button renders disabled. */
  disabled?: boolean;
  /** Tooltip override; defaults to `label`. */
  title?: string;
  /** When true, the action-sheet row uses the destructive (red) hover background. */
  destructive?: boolean;
}

/** Convenience: drop hidden actions, used by both renderers. */
export function visibleActions(actions: RowAction[]): RowAction[] {
  return actions.filter((a) => !a.hidden);
}
