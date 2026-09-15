'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import {
  CAPTION_CLASS,
  CellLabel,
  Td,
  Th,
  TABLE_BODY_CLASS,
  TABLE_CLASS,
} from '@/components/ui/Table';
import { backupApi, StoredBackup, StoredBackupsReport } from '@/lib/backupApi';
import { getErrorMessage } from '@/lib/errors';
import { downloadBlob } from '@/lib/download';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import {
  cn,
  formatDatetimeLocal,
  isoToDatetimeLocal,
  resolveTimezone,
} from '@/lib/utils';
import { useAuthStore } from '@/store/authStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { OffsiteDestinationsForm } from './OffsiteDestinationsForm';
import { OffsiteStatusIcons } from './OffsiteStatusIcons';

interface StoredBackupsSubsectionProps {
  /**
   * Hands the chosen artifact to the restore form above, as the `File` a user
   * would have picked themselves. Restoring is deliberately not done here: the
   * refusals that make a restore safe -- the warning, the encrypted-backup
   * password, the account password or the OIDC round trip, and the summary
   * dialogue afterwards -- belong to one workflow, and a second copy of it
   * beside this table is how the two drift apart.
   */
  onRestore: (file: File) => void;
}

/**
 * The automatic backups this server is holding for the signed-in user.
 *
 * **Present only when there is something to say.** The schedule is an operator
 * setting on an admin-only endpoint, so this reader cannot be asked whether it
 * is armed -- the listing answers it instead (`enabled`), and a deployment that
 * runs no automatic backups renders no section at all. The one exception is a
 * folder that still holds artifacts after the schedule was turned off: those
 * are recoverable data, and the only screen that can hand them back is this
 * one, so it stays for as long as they exist.
 *
 * **Folded away by default.** The heading stays visible, so nothing about the
 * feature is hidden; what folds is a file listing most visits to Settings have
 * no use for. The fold is not persisted per reader the way the foldable
 * Settings *sections* are (`settingsSectionStore`): those record a preference
 * about a panel of controls, and this is a data table inside one.
 */
export function StoredBackupsSubsection({
  onRestore,
}: StoredBackupsSubsectionProps) {
  const t = useTranslations('settings.backupRestore.storedBackups');
  const { formatBytes } = useNumberFormat();
  // The schedule behind these artifacts is configured on an admin-only page, so
  // only an administrator is pointed at it: for everyone else the link is a
  // route they would be refused at.
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const preferences = usePreferencesStore((s) => s.preferences);
  const timezone = resolveTimezone(preferences?.timezone);
  const dateFormat = preferences?.dateFormat || 'browser';
  const timeFormat = preferences?.timeFormat || '24h';

  const [open, setOpen] = useState(false);
  // The off-site destinations fold within this sub-section, collapsed by
  // default: the configuration is most visits' business no more than the file
  // listing is, and the maintainer asked for it under this heading rather than
  // as a section of its own.
  const [offsiteOpen, setOffsiteOpen] = useState(false);
  const [report, setReport] = useState<StoredBackupsReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // A failed read is not "no backups", and it is not "the schedule is off"
  // either. Both of those would be answered by hiding this section, which is
  // the one thing that must not happen on an error: it would tell the reader
  // their server is holding nothing.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Which row is working, and at what. The action is part of it so a restore's
  // fetch does not relabel the Download button beside it.
  const [busy, setBusy] = useState<{
    filename: string;
    action: 'download' | 'restore';
  } | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      setReport(await backupApi.listStoredBackups());
    } catch (error) {
      setReport(null);
      setLoadError(getErrorMessage(error, t('loadFailed')));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  // The element's own `toggle` event fires for the state change React just
  // made, so the summary's click and that event both arrive for one expand.
  // Compared against a ref rather than `open`, which is still the previous
  // render's value when the second of the two lands.
  const openRef = useRef(false);
  const handleToggle = (next: boolean) => {
    if (openRef.current === next) return;
    openRef.current = next;
    setOpen(next);
    // Re-read on every expand: the schedule writes and retention deletes while
    // this page is open, and a list that is wrong about which artifacts exist
    // is worse than one that takes a moment to arrive.
    if (next) load();
  };

  // The inner off-site disclosure. Controlled the same way and for the same
  // reason: jsdom flips `open` on a summary click but fires no `toggle` event,
  // so `onToggle` cannot be the only mover.
  const offsiteOpenRef = useRef(false);
  const handleOffsiteToggle = (next: boolean) => {
    if (offsiteOpenRef.current === next) return;
    offsiteOpenRef.current = next;
    setOffsiteOpen(next);
  };

  const handleDownload = async (backup: StoredBackup) => {
    setBusy({ filename: backup.filename, action: 'download' });
    try {
      const file = await backupApi.downloadStoredBackup(backup.filename);
      downloadBlob(file, backup.filename);
    } catch (error) {
      toast.error(getErrorMessage(error, t('downloadFailed')));
    } finally {
      setBusy(null);
    }
  };

  const handleRestore = async (backup: StoredBackup) => {
    setBusy({ filename: backup.filename, action: 'restore' });
    try {
      onRestore(await backupApi.downloadStoredBackup(backup.filename));
    } catch (error) {
      toast.error(getErrorMessage(error, t('downloadFailed')));
    } finally {
      setBusy(null);
    }
  };

  const formatModified = (iso: string): string =>
    formatDatetimeLocal(
      isoToDatetimeLocal(iso, timezone),
      dateFormat,
      timeFormat,
    );

  // Nothing scheduled and nothing on disk: the feature is not part of this
  // deployment, so the section is not part of this page.
  if (report && !report.enabled && report.backups.length === 0) return null;
  // Nothing known yet. Rendering a heading here would put a section on screen
  // that the first answer may take straight back off again.
  if (!report && !loadError) return null;

  const backups = report?.backups ?? [];

  return (
    <div className="mb-6 pb-6 border-b border-gray-200 dark:border-gray-700">
      <details
        open={open}
        // React does not manage `open` for us, so a toggle the summary's own
        // click handler did not produce (Chrome expands a `<details>` to show a
        // find-in-page match) would otherwise leave this state disagreeing with
        // the DOM.
        onToggle={(event) => handleToggle(event.currentTarget.open)}
      >
        <summary
          className="cursor-pointer"
          data-testid="stored-backups-summary"
          onClick={(event) => {
            // Cancels the element's own activation behaviour so `open` moves
            // only through this state. Enter and Space on a focused summary
            // dispatch a click too, so the keyboard path comes with it.
            event.preventDefault();
            handleToggle(!open);
          }}
        >
          <h3 className="inline text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('heading')}
          </h3>
        </summary>

        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          {t('description')}
        </p>

        {isAdmin && (
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            {t.rich('adminScheduleNote', {
              link: (chunks) => (
                <Link
                  href="/admin/backups"
                  className="underline hover:no-underline"
                >
                  {chunks}
                </Link>
              ),
            })}
          </p>
        )}

        {/* The user's own off-machine destinations for these artifacts, folded
            in here rather than shown as a section of its own: a copy off the
            machine is a fact about the same automatic backups this sub-section
            lists. Collapsed by default. */}
        <details
          className="mt-4"
          open={offsiteOpen}
          onToggle={(event) => handleOffsiteToggle(event.currentTarget.open)}
        >
          <summary
            className="cursor-pointer"
            data-testid="offsite-destinations-summary"
            onClick={(event) => {
              event.preventDefault();
              handleOffsiteToggle(!offsiteOpen);
            }}
          >
            <h4 className="inline text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('offsite.disclosure')}
            </h4>
          </summary>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            {t('offsite.disclosureDescription')}
          </p>
          <OffsiteDestinationsForm />
        </details>

        <div className="mt-4">
          {isLoading && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('loading')}
            </p>
          )}

          {!isLoading && loadError && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-red-600 dark:text-red-400">
                {loadError}
              </p>
              <Button variant="outline" size="sm" onClick={load}>
                {t('retryButton')}
              </Button>
            </div>
          )}

          {!isLoading && !loadError && backups.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('empty')}
            </p>
          )}

          {!isLoading && !loadError && backups.length > 0 && (
            // Below `sm` the table becomes a block and each row wraps into a
            // three-line grid card: the filename on a line of its own, the
            // modification time on the next, and the size beside the row's two
            // stacked buttons on the last. From `sm` up it is the ordinary
            // table, resolved exactly as it was before the wrap. Explicit
            // `role`s put back the table semantics that restyling `display`
            // strips (inert from `sm` up).
            //
            // Only the size shares a line with the buttons, and that is the
            // measurement this layout is built on: the button column is as wide
            // as its longest label, which is a translation (`Herunterladen`,
            // `Working...`), so the cell beside it has to be the one figure that
            // cannot be crowded. A datetime there overflowed 320px in a locale
            // with a long label, reopening the sideways scroll the card closes.
            //
            // The whole list sits in a fixed-height window (`max-h-96`, about a
            // dozen rows) that scrolls: a deployment can hold months of daily
            // artifacts, and a listing that grows without bound dominates the
            // Settings page. Newest-first order is the server's.
            <div className="max-h-96 overflow-y-auto overflow-x-auto">
              <table role="table" className={cn(TABLE_CLASS, 'block sm:table')}>
                <thead role="rowgroup" className="block sm:table-header-group">
                  <tr role="row" className="hidden sm:table-row">
                    <Th role="columnheader">{t('columns.filename')}</Th>
                    <Th role="columnheader">{t('columns.modified')}</Th>
                    <Th role="columnheader" align="right">
                      {t('columns.size')}
                    </Th>
                    <Th role="columnheader" align="right">
                      <span className="sr-only">{t('columns.actions')}</span>
                    </Th>
                  </tr>
                </thead>
                <tbody
                  role="rowgroup"
                  className={cn(TABLE_BODY_CLASS, 'block sm:table-row-group')}
                >
                  {backups.map((backup) => (
                    <tr
                      key={backup.filename}
                      role="row"
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5 px-4 py-3 sm:table-row sm:p-0"
                    >
                      <Td
                        role="cell"
                        className="col-span-2 row-start-1 p-0 break-all font-mono text-xs sm:table-cell sm:px-4 sm:py-3"
                      >
                        {backup.filename}
                        {/* Whether each configured destination copied this
                            artifact off the machine, one small icon each, drawn
                            only for a destination that has a status for it. */}
                        <OffsiteStatusIcons
                          offsite={backup.offsite}
                          className="mt-1 flex"
                        />
                      </Td>
                      <Td
                        role="cell"
                        className="col-span-2 row-start-2 p-0 text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm"
                      >
                        <CellLabel className={CAPTION_CLASS}>
                          {t('columns.modified')}
                        </CellLabel>
                        {formatModified(backup.modifiedAt)}
                      </Td>
                      <Td
                        role="cell"
                        className="col-start-1 row-start-3 p-0 text-left text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-right sm:text-sm"
                      >
                        <CellLabel className={CAPTION_CLASS}>
                          {t('columns.size')}
                        </CellLabel>
                        {formatBytes(backup.size)}
                      </Td>
                      <Td
                        role="cell"
                        className="col-start-2 row-start-3 p-0 sm:table-cell sm:px-4 sm:py-3 sm:text-right"
                      >
                        {/* Stacked on a phone, so the widest label rather than
                            the pair of them decides how much width the buttons
                            take from the figure beside them; side by side from
                            `sm`, as the table always drew them. */}
                        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy !== null}
                            onClick={() => handleDownload(backup)}
                          >
                            {busy?.filename === backup.filename &&
                            busy.action === 'download'
                              ? t('workingButton')
                              : t('downloadButton')}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy !== null}
                            onClick={() => handleRestore(backup)}
                          >
                            {busy?.filename === backup.filename &&
                            busy.action === 'restore'
                              ? t('workingButton')
                              : t('restoreButton')}
                          </Button>
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
