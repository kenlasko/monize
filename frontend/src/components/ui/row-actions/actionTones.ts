import type { ActionTone } from './rowAction';

/**
 * Text/hover color for a desktop action button (normal-density text label and
 * compact/dense icon-only). Mirrors the per-verb color conventions already used
 * across the lists so existing rows look unchanged: edit=blue, delete=red,
 * reconcile/post/reactivate=green, close/skip=orange, merge/schedule=purple.
 */
export const TONE_TEXT_CLASS: Record<ActionTone, string> = {
  primary: 'text-blue-600 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300',
  view: 'text-emerald-600 dark:text-emerald-400 hover:text-emerald-900 dark:hover:text-emerald-300',
  delete: 'text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300',
  success: 'text-green-600 dark:text-green-400 hover:text-green-900 dark:hover:text-green-300',
  warning: 'text-orange-600 dark:text-orange-400 hover:text-orange-900 dark:hover:text-orange-300',
  accent: 'text-purple-600 dark:text-purple-400 hover:text-purple-900 dark:hover:text-purple-300',
  neutral: 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200',
};

/**
 * Icon tint for an action-sheet (mobile) row. Destructive actions are red; every
 * other verb is neutral gray, matching the original TransactionActionSheet.
 */
export const TONE_SHEET_ICON_CLASS: Record<ActionTone, string> = {
  primary: 'text-gray-400',
  view: 'text-gray-400',
  delete: 'text-red-600 dark:text-red-400',
  success: 'text-gray-400',
  warning: 'text-gray-400',
  accent: 'text-gray-400',
  neutral: 'text-gray-400',
};
