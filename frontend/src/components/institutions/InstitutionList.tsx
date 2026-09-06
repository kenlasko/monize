'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Institution } from '@/types/institution';
import { institutionsApi } from '@/lib/institutions';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { useTableDensity } from '@/hooks/useTableDensity';
import { useDensityPreference } from '@/store/densityStore';
import { SortIcon } from '@/components/ui/SortIcon';
import { safeHttpUrl } from '@/lib/safe-url';
import { InstitutionLogo } from './InstitutionLogo';
import { useLongPress } from '@/hooks/useLongPress';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import { RowActionSheet } from '@/components/ui/row-actions/RowActionSheet';
import type { RowAction } from '@/components/ui/row-actions/rowAction';
import { DensityToggleBar } from '@/components/ui/DensityToggle';
import { EmptyState } from '@/components/ui/EmptyState';
import { useIsMobile } from '@/hooks/useIsMobile';
import { CellLabel } from '@/components/ui/Table';
import type { LongPressRowHandlers } from '@/hooks/useLongPress';
import type { DensityLevel } from '@/hooks/useTableDensity';

const logger = createLogger('InstitutionList');

/**
 * Builds the standard row actions for an institution. Shared by the desktop
 * `RowActions` cell and the mobile `RowActionSheet`.
 */
function buildInstitutionActions(
  institution: Institution,
  labels: { edit: string; delete: string },
  handlers: { onEdit: (institution: Institution) => void; onDeleteClick: (institution: Institution) => void },
): RowAction[] {
  return [
    { key: 'edit', label: labels.edit, icon: 'edit', tone: 'primary', onClick: () => handlers.onEdit(institution) },
    { key: 'delete', label: labels.delete, icon: 'delete', tone: 'delete', destructive: true, onClick: () => handlers.onDeleteClick(institution) },
  ];
}

export type InstitutionSortField = 'name' | 'website' | 'country' | 'accounts';

/**
 * Every field this list sorts by, in the tier header's own order: the label
 * that names it, and the visibility class its tier header cell carries.
 *
 * Both headers are built from this one list, so they cannot drift. The phone's
 * slim control header offers all four fields -- not the two the tier layout
 * still shows at phone width -- because the chosen field is held by the
 * Institutions page and Website and Country are exactly the columns this table
 * hides below `md` and `sm`: a header offering fewer would leave a phone sorted
 * by a field it can neither see nor undo. Actions is absent from the list
 * because it is not sortable, and its `<th>` is written out below.
 *
 * That runs the other way too, and the escape is what makes it acceptable:
 * sorting by Website or Country from the card and then switching to Compact
 * brings back a tier header whose only visible controls are Name and Accounts,
 * so the order in force is one this header no longer names. Nothing is
 * stranded -- tapping Name re-sorts to a field that IS on screen, and Normal
 * density (the same toggle, one tap) restores all four controls -- but the two
 * headers do disagree about which orders they can express, and only the card's
 * can express every one.
 */
const SORT_COLUMNS = [
  { field: 'name', labelKey: 'list.columns.name', tierVisibility: '' },
  { field: 'website', labelKey: 'list.columns.website', tierVisibility: 'hidden md:table-cell' },
  { field: 'country', labelKey: 'list.columns.country', tierVisibility: 'hidden sm:table-cell' },
  { field: 'accounts', labelKey: 'list.columns.accounts', tierVisibility: '' },
] as const satisfies ReadonlyArray<{
  field: InstitutionSortField;
  labelKey: string;
  tierVisibility: string;
}>;

/**
 * The tier header cell's class string, with the separator after the visibility
 * class supplied HERE rather than baked into the entry above.
 *
 * A `tierVisibility` carrying its own trailing space is a trap the compiler
 * cannot see: written the natural way, a fifth column's `hidden lg:table-cell`
 * would concatenate straight onto the next token as `lg:table-cellcursor-pointer`,
 * destroying the responsive class while the bare `hidden` survived -- so that
 * column would vanish at every width, with types, lint and a header test that
 * compares label text all still green. Owning the space here makes an entry
 * that omits it correct by construction, and
 * `InstitutionList.mobileWrapped.test.tsx` reads the tokens off `classList` so
 * a fused pair fails a test rather than only a screenshot.
 */
function tierHeaderClass(headerPadding: string, tierVisibility: string, sortable: boolean): string {
  return `${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider ${tierVisibility ? `${tierVisibility} ` : ''}${sortable ? 'cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 select-none' : ''}`;
}

/** What the Country column shows, including its placeholder for no country. */
function institutionCountryText(institution: Institution): string {
  return institution.country || '—';
}

/**
 * The website as the row renders it: an external link when the stored value is
 * an http(s) URL, plain text otherwise, so a `javascript:` URI can never reach
 * an `href`. That is a decision rather than a label, so both layouts render it
 * from here -- and the link stops its click from reaching the row, which is
 * what keeps the row's press handlers from also acting on it.
 */
function InstitutionWebsite({ institution }: { institution: Institution }) {
  const href = safeHttpUrl(institution.website);
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="text-sm text-blue-600 dark:text-blue-400 hover:underline truncate inline-block max-w-full"
    >
      {institution.website}
    </a>
  ) : (
    <span className="text-sm text-gray-500 dark:text-gray-400 truncate inline-block max-w-full">
      {institution.website}
    </span>
  );
}

/**
 * The account count, which is also the control that opens this institution's
 * accounts. Rendered from here in both layouts so the count and the action on
 * it cannot diverge between them.
 */
function InstitutionAccountsButton({
  institution,
  onManageAccounts,
}: {
  institution: Institution;
  onManageAccounts: (institution: Institution) => void;
}) {
  const t = useTranslations('institutions');
  return (
    <button
      onClick={() => onManageAccounts(institution)}
      aria-label={t('list.accountCount', { count: institution.accountCount })}
      title={t('list.actions.manageAccounts')}
      className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
    >
      {institution.accountCount}
    </button>
  );
}

interface InstitutionRowProps {
  institution: Institution;
  density: DensityLevel;
  cellPadding: string;
  onEdit: (institution: Institution) => void;
  onDeleteClick: (institution: Institution) => void;
  onManageAccounts: (institution: Institution) => void;
  getRowHandlers: (institution: Institution) => LongPressRowHandlers;
  /**
   * Render the row as a wrapped card instead of the tier table's cells. The
   * list sets it for phones at Normal density only (Model B: on a phone the
   * density toggle picks the layout); every other width and every other
   * density renders the tier row below, unchanged.
   *
   * The card carries every value the tier row shows -- the logo, the name, the
   * account count, the country and the website, the last three captioned with
   * the column labels the card no longer has a header to supply. Only the
   * Actions column is left out: Edit and Delete are what the long-press (and
   * right-click) sheet these same row handlers open already carries. The
   * country keeps its em-dash placeholder rather than disappearing, because
   * that is what the column it comes from shows.
   *
   * The two breakpoints are not the same one. The tier row's Actions cell is
   * `min-[480px]`, and `wrapped` covers everything below 640px, so between
   * 480px and 639px at Normal density the actions move from inline buttons to
   * that sheet -- which also means they stop being tab-reachable there. It is
   * the price of the card, paid for the Website and Country this table hides
   * below `md` and `sm`, and the register, the accounts list and the categories
   * list all make the same trade at the same two widths, so every list behaves
   * alike. Compact density, one tap away, is the way back to inline actions.
   */
  wrapped?: boolean;
}

function InstitutionRow({
  institution,
  density,
  cellPadding,
  onEdit,
  onDeleteClick,
  onManageAccounts,
  getRowHandlers,
  wrapped = false,
}: InstitutionRowProps) {
  const t = useTranslations('institutions');
  const tc = useTranslations('common');

  // Phone + Normal density: one wrapped card per row instead of the tier
  // table's cells (see the `wrapped` prop). It is a LAYOUT mode, not a
  // different set of facts -- the logo, the website's link-or-text decision,
  // the country's placeholder and the account count all come from the same
  // helpers the tier branch below renders, so the two cannot disagree about
  // what an institution is.
  if (wrapped) {
    return (
      <tr
        className="hover:bg-gray-50 dark:hover:bg-gray-800 select-none"
        {...getRowHandlers(institution)}
      >
        <td className="p-0">
          {/* The inset is the density table's, not a hand-picked one: two
              insets on one screen misalign, and the header above these cards
              is padded from the same table. */}
          <div className={cellPadding}>
            {/* A grid, not a flex row, and `minmax(0,1fr)` rather than a plain
                `1fr`: a track that may be zero lets the name truncate, where a
                flex item's `min-w-0` still contributes the full width of its
                nowrap text to the table's minimum. On a phone that is not
                merely a scrollbar -- mobile Chrome sizes the viewport
                `position: fixed` attaches to from the widest content on the
                page. The card has room for the logo, so it carries no
                responsive hiding of its own. */}
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 items-start">
              <InstitutionLogo
                institution={institution}
                size={24}
                fallbackGlyph="$"
                className="mt-0.5"
              />
              {/* The name is the only value here with nothing beside it -- this
                  table has no badge on the row -- so it truncates in its own
                  track rather than needing a wrapping flex row to keep its
                  width from a sibling. */}
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                {institution.name}
              </span>
              {/* A bare number with no column header to name it, so it carries
                  the header's own label. The caption is its own node, above the
                  value's, so a test still matches the count on its own. */}
              <div className="text-right whitespace-nowrap">
                <CellLabel>{t('list.columns.accounts')}</CellLabel>
                <InstitutionAccountsButton
                  institution={institution}
                  onManageAccounts={onManageAccounts}
                />
              </div>
              {/* Line 2 is its own grid for the same reason line 1 is: the
                  website truncates, so it needs a track with a zero minimum
                  rather than a flex slot. The country sits in the `auto` track
                  because a two-letter code (or the placeholder) is narrow and
                  fixed, leaving every spare pixel to the URL. */}
              <div className="col-span-3 grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3">
                <div>
                  <CellLabel>{t('list.columns.country')}</CellLabel>
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    {institutionCountryText(institution)}
                  </div>
                </div>
                <div className="min-w-0">
                  <CellLabel>{t('list.columns.website')}</CellLabel>
                  <InstitutionWebsite institution={institution} />
                </div>
              </div>
            </div>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr
      className="hover:bg-gray-50 dark:hover:bg-gray-800 select-none"
      {...getRowHandlers(institution)}
    >
      <td className={cellPadding}>
        <div className="flex items-center gap-3 min-w-0">
          <InstitutionLogo institution={institution} size={24} fallbackGlyph="$" />
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            {institution.name}
          </span>
        </div>
      </td>
      <td className={`${cellPadding} hidden md:table-cell max-w-[16rem]`}>
        <InstitutionWebsite institution={institution} />
      </td>
      <td className={`${cellPadding} hidden sm:table-cell text-sm text-gray-500 dark:text-gray-400`}>
        {institutionCountryText(institution)}
      </td>
      <td className={cellPadding}>
        <InstitutionAccountsButton
          institution={institution}
          onManageAccounts={onManageAccounts}
        />
      </td>
      <td className={`${cellPadding} text-right whitespace-nowrap hidden min-[480px]:table-cell`} onClick={(e) => e.stopPropagation()}>
        <RowActions
          actions={buildInstitutionActions(
            institution,
            { edit: tc('actions.edit'), delete: tc('actions.delete') },
            { onEdit, onDeleteClick },
          )}
          density={density}
        />
      </td>
    </tr>
  );
}

interface InstitutionListProps {
  institutions: Institution[];
  onEdit: (institution: Institution) => void;
  onDelete: (id: string) => void;
  onManageAccounts: (institution: Institution) => void;
  sortField?: InstitutionSortField;
  sortDirection?: 'asc' | 'desc';
  onSort?: (field: InstitutionSortField) => void;
}

export function InstitutionList({
  institutions,
  onEdit,
  onDelete,
  onManageAccounts,
  sortField = 'name',
  sortDirection = 'asc',
  onSort,
}: InstitutionListProps) {
  const t = useTranslations('institutions');
  const tc = useTranslations('common');
  const { density } = useDensityPreference('institutions');
  const { cellPadding, headerPadding } = useTableDensity(density);
  // Model B: on a phone, density picks the LAYOUT rather than only the row
  // height. At Normal each institution is a wrapped card carrying the Website
  // and Country this table hides below `md`/`sm`; Compact and Dense keep the
  // tier table, unchanged, and so does every non-phone width. Exactly one
  // branch renders per row, chosen here. This list is mounted from one place
  // (the Institutions page), so there is no surface whose extra columns the
  // card would have to carry or be excluded for.
  const isMobile = useIsMobile();
  const wrapped = isMobile && density === 'normal';
  const [toDelete, setToDelete] = useState<Institution | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [contextInstitution, setContextInstitution] = useState<Institution | null>(null);

  const { getRowHandlers } = useLongPress<Institution>({
    onLongPress: setContextInstitution,
  });

  const handleDeleteConfirm = async () => {
    if (!toDelete) return;
    setIsDeleting(true);
    try {
      await institutionsApi.delete(toDelete.id);
      toast.success(t('list.deleted', { name: toDelete.name }));
      onDelete(toDelete.id);
      setToDelete(null);
    } catch (error) {
      toast.error(getErrorMessage(error, t('list.deleteFailed')));
      logger.error(error);
    } finally {
      setIsDeleting(false);
    }
  };

  if (institutions.length === 0) {
    return (
      <EmptyState title={t('list.empty')} />
    );
  }

  return (
    <div>
      <DensityToggleBar view="institutions" />
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead className={`bg-gray-50 dark:bg-gray-800${wrapped && !onSort ? ' hidden' : ''}`}>
          {wrapped ? (
          /* On a phone the wrapped card labels its own values, so the column
             header is dropped -- but the controls in that header row must not
             go with it: these `<th>`s are how the list is sorted, the chosen
             field is held by the Institutions page, and Website and Country
             are the columns hidden below `md`/`sm`, so a phone could be left
             sorted by a field it can neither see nor undo. A slim control
             header carries all four fields as buttons -- the card shows all
             four values -- and no column label of its own: the single card
             cell below holds name, accounts, country and website at once, so
             naming this header after any one of them would misdescribe the
             column to a screen reader. Each button names itself with the label
             of the field it sorts by. Without `onSort` nothing here is
             interactive, and the header is hidden outright (above). */
          <tr>
            {/* The one column is always sorted by something, and `aria-sort`
                is the only place that direction is announced -- the arrow in
                each button's label is a glyph, not a state. It is withheld
                when this header names no sort field at all. */}
            <th
              className={`${headerPadding} text-left`}
              aria-sort={onSort ? (sortDirection === 'asc' ? 'ascending' : 'descending') : undefined}
            >
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {onSort && SORT_COLUMNS.map(({ field, labelKey }) => (
                  <button
                    key={field}
                    type="button"
                    onClick={() => onSort(field)}
                    className="flex items-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider rounded focus-visible:outline-2 focus-visible:outline-blue-500"
                  >
                    {t(labelKey)}
                    <SortIcon field={field} sortField={sortField} sortDirection={sortDirection} />
                  </button>
                ))}
              </div>
            </th>
          </tr>
          ) : (
          <tr>
            {SORT_COLUMNS.map(({ field, labelKey, tierVisibility }) => (
              <th
                key={field}
                className={tierHeaderClass(headerPadding, tierVisibility, !!onSort)}
                onClick={onSort ? () => onSort(field) : undefined}
              >
                {t(labelKey)}
                {onSort && <SortIcon field={field} sortField={sortField} sortDirection={sortDirection} />}
              </th>
            ))}
            <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden min-[480px]:table-cell`}>
              {t('list.columns.actions')}
            </th>
          </tr>
          )}
        </thead>
        <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
          {institutions.map((institution) => (
            <InstitutionRow
              key={institution.id}
              institution={institution}
              density={density}
              cellPadding={cellPadding}
              onEdit={onEdit}
              onDeleteClick={setToDelete}
              onManageAccounts={onManageAccounts}
              getRowHandlers={getRowHandlers}
              wrapped={wrapped}
            />
          ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        isOpen={toDelete !== null}
        title={t('list.deleteTitle')}
        message={
          toDelete ? t('list.deleteMessage', { name: toDelete.name }) : ''
        }
        confirmLabel={
          isDeleting ? t('list.deleting') : tc('delete')
        }
        cancelLabel={tc('cancel')}
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setToDelete(null)}
      />

      <RowActionSheet
        isOpen={contextInstitution !== null}
        title={contextInstitution?.name ?? ''}
        subtitle={contextInstitution?.country ?? undefined}
        actions={contextInstitution
          ? buildInstitutionActions(
              contextInstitution,
              { edit: tc('actions.edit'), delete: tc('actions.delete') },
              { onEdit, onDeleteClick: setToDelete },
            )
          : []}
        onClose={() => setContextInstitution(null)}
      />
    </div>
  );
}
