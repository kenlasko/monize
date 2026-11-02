'use client';

import { useTranslations } from 'next-intl';
import { CalendarMonthNav } from '@/components/calendar/CalendarMonthNav';
import { HOVER_ROW_ON_PAGE } from '@/components/ui/Card';
import { SCHEDULED_KIND_CHIP_CLASSES } from '@/lib/scheduled-kind';
import { ACCOUNT_TYPE_META } from '@/lib/account-type-meta';
import type { AccountType } from '@/types/account';
import type { CalendarLayer } from '@/store/viewModeStore';

/**
 * Generic over the layers this toolbar offers rather than over every layer
 * that exists.
 *
 * `useViewMode(surface).toggleLayer` takes that surface's own layers, so a
 * toolbar declaring the flat `CalendarLayer` union cannot be handed one: the
 * parameter is contravariant, and the assignment is a type error. Inferring
 * `L` from `availableLayers` also says the true thing, which is that this
 * toolbar can only toggle a layer it draws a button for.
 */
interface CalendarToolbarProps<L extends CalendarLayer> {
  /** `YYYY-MM`. */
  month: string;
  onMonthChange: (month: string) => void;
  /** The server's financial today; the Today button goes to its month. */
  today: string;
  /** Id the grid points `aria-labelledby` at, so the grid is named by its month. */
  monthLabelId: string;
  /** The layers this surface offers, in toolbar order. */
  availableLayers: readonly L[];
  activeLayers: readonly CalendarLayer[];
  onToggleLayer: (layer: L) => void;
  /** Account types present in the month, for the legend. */
  legendAccountTypes: readonly AccountType[];
  /** Whether the month holds any scheduled occurrence. */
  legendHasScheduled: boolean;
  /**
   * The Table / Calendar switch, first in the row.
   *
   * It lives here rather than beside the page title so it sits in the same row
   * as the month navigation and the legend, which is where the rest of the
   * calendar's chrome is; in table mode the same control leads the register's
   * own toolbar (`ListTopToolbar`), so the switch stays at the left-hand end
   * whichever view is showing. Passed in rather than rendered here because
   * which surface it switches is the page's business, not this row's.
   */
  viewToggle?: React.ReactNode;
}

const LAYER_BUTTON =
  'px-3 py-1 text-sm font-medium rounded-md border transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';
const LAYER_ON =
  'border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-900/30 dark:text-blue-300';
const LAYER_OFF =
  `border-gray-300 text-gray-600 dark:border-gray-600 dark:text-gray-400 ${HOVER_ROW_ON_PAGE}`;

/**
 * The catalogue key for one layer's button.
 *
 * Written as its own function so the key is the concrete
 * `layers.${CalendarLayer}` union rather than one built from the generic `L`,
 * which next-intl cannot resolve to a message.
 */
function layerLabelKey(layer: CalendarLayer): `layers.${CalendarLayer}` {
  return `layers.${layer}`;
}

/**
 * The row above the grid: which month, which layers, and what the colours mean.
 *
 * The month is the calendar's own state rather than the page's date filter
 * (design decision 2), so the navigation here is the only thing that moves it.
 */
export function CalendarToolbar<L extends CalendarLayer>({
  month,
  onMonthChange,
  today,
  monthLabelId,
  availableLayers,
  activeLayers,
  onToggleLayer,
  legendAccountTypes,
  legendHasScheduled,
  viewToggle,
}: CalendarToolbarProps<L>) {
  const t = useTranslations('calendar');
  const common = useTranslations('common');

  // From `sm` up, three columns: the switch at the left-hand end, the month
  // navigation in the middle, and the layers at the right-hand end, with the
  // legend on a line below. The outer columns share the free space equally, so the
  // month is centred on the page rather than in whatever the switch leaves.
  // Below `sm` it is one wrapping row, switch first.
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 sm:grid sm:grid-cols-[1fr_auto_1fr]">
      <div className="flex items-center sm:justify-self-start">{viewToggle}</div>

      <CalendarMonthNav
        month={month}
        onMonthChange={onMonthChange}
        today={today}
        monthLabelId={monthLabelId}
      />

      {/* The layer buttons hold the right-hand end of the row. Below `sm`
          they take a line of their own and share its width, as a list
          page's segmented filter does. */}
      <div className="flex w-full items-center sm:w-auto sm:justify-self-end">
        <div className="flex w-full items-center gap-1 sm:w-auto" role="group" aria-label={t('toolbar.layers')}>
          {availableLayers.map((layer) => (
            <button
              key={layer}
              type="button"
              aria-pressed={activeLayers.includes(layer)}
              onClick={() => onToggleLayer(layer)}
              className={`${LAYER_BUTTON} grow sm:grow-0 ${activeLayers.includes(layer) ? LAYER_ON : LAYER_OFF}`}
            >
              {t(layerLabelKey(layer))}
            </button>
          ))}
        </div>
      </div>

      {/* The legend is a line of its own under the row, flush right below
          the layers: beside them it does not fit at desktop widths, and
          wrapping it there lifts it above the month the row is centred on. */}
      {(legendAccountTypes.length > 0 || legendHasScheduled) && (
        <ul
          className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:col-span-3 sm:justify-self-end sm:justify-end"
          aria-label={t('legend.label')}
        >
          {legendAccountTypes.map((accountType) => (
            <li key={accountType} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`inline-block w-3 h-3 rounded-sm ${ACCOUNT_TYPE_META[accountType].pillClass}`}
              />
              <span className="text-xs text-gray-600 dark:text-gray-400">
                {common(`accountTypes.${accountType}`)}
              </span>
            </li>
          ))}
          {legendHasScheduled && (
            <li className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`inline-block w-3 h-3 rounded-sm border border-dashed border-current ${SCHEDULED_KIND_CHIP_CLASSES.bill}`}
              />
              <span className="text-xs text-gray-600 dark:text-gray-400">
                {t('legend.scheduled')}
              </span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
