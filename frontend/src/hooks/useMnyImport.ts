'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { getErrorCode, getErrorMessage } from '@/lib/errors';
import {
  MnyImportJob,
  MnyImportOptionsInput,
  MnyPreview,
  MnyRename,
  BinaryImportClient,
  mnyImportApi,
} from '@/lib/import-mny';

/**
 * State machine for a Microsoft Money import: upload, review, run, verify.
 *
 * Kept out of `useImportWizard` because almost none of that hook applies -- a
 * `.mny` file needs no account selection, no category mapping and no date-format
 * guessing (Money stores real dates and exact transfer links). What it does need
 * is a password prompt and job polling, neither of which the text-file importers
 * have.
 */

/** How often the wizard asks the job how it is doing (design ADR-3). */
export const MNY_POLL_INTERVAL_MS = 1500;

/** Parse failures the wizard reacts to rather than merely displaying. */
const PASSWORD_REQUIRED = 'mnyPasswordRequired';
const PASSWORD_INCORRECT = 'mnyPasswordIncorrect';

export interface MnyUploadError {
  /** Stable backend code, or undefined for an unexpected failure. */
  code?: string;
  /** Localized message from the backend. */
  message: string;
  /**
   * The request never got an answer about the file: it timed out, the network
   * dropped, or the proxy answered 502/503/504. Said to be that, never shown as
   * a damaged file.
   */
  requestFailed?: boolean;
}

/** A request that did not get an answer from the application, as opposed to one it refused. */
function isRequestFailure(error: unknown): boolean {
  if (!isAxiosError(error)) return false;
  const status = error.response?.status;
  return status === undefined || status === 502 || status === 503 || status === 504;
}

export interface UseMnyImportResult {
  preview: MnyPreview | null;
  job: MnyImportJob | null;
  isUploading: boolean;
  isStarting: boolean;
  /** Set when the file needs a password, or the one supplied was wrong. */
  passwordPrompt: { retry: boolean } | null;
  uploadError: MnyUploadError | null;
  /** Money account handles the user has unticked. */
  excludedHandles: ReadonlySet<number>;
  /** Per-account currency overrides, keyed by Money handle. */
  currencyOverrides: ReadonlyMap<number, string>;
  /**
   * `BILL.hbill` handles the user has ticked. Tracked as an inclusion set
   * rather than an exclusion one because the import writes exactly this list:
   * an unticked bill is never created, not created inactive.
   */
  selectedBillHandles: ReadonlySet<number>;
  options: MnyImportOptionsInput;
  upload: (file: File, password?: string) => Promise<boolean>;
  /** Re-uploads the file already chosen, with the password just entered. */
  retryWithPassword: (password: string) => Promise<boolean>;
  toggleAccount: (handle: number) => void;
  setAllAccounts: (include: boolean) => void;
  setAccountCurrency: (handle: number, currencyCode: string | null) => void;
  toggleBill: (handle: number) => void;
  setAllBills: (include: boolean) => void;
  setOption: <K extends keyof MnyImportOptionsInput>(
    key: K,
    value: MnyImportOptionsInput[K],
  ) => void;
  /** Sets the name one too-long name is imported under (`options.renames`). */
  setRename: (rename: MnyRename) => void;
  start: (wipePassword?: string) => Promise<boolean>;
  retry: () => Promise<boolean>;
  cancelPasswordPrompt: () => void;
  reset: () => void;
}

/**
 * `client` is the format's API (`mnyImportApi` by default, `kmyImportApi` for a
 * KMyMoney file); everything else is the same state machine. A client that
 * never asks for a password simply never opens the prompt.
 */
export function useMnyImport(
  client: BinaryImportClient = mnyImportApi,
): UseMnyImportResult {
  const [preview, setPreview] = useState<MnyPreview | null>(null);
  const [job, setJob] = useState<MnyImportJob | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [passwordPrompt, setPasswordPrompt] = useState<{
    retry: boolean;
  } | null>(null);
  const [uploadError, setUploadError] = useState<MnyUploadError | null>(null);
  const [excludedHandles, setExcludedHandles] = useState<Set<number>>(
    new Set(),
  );
  const [currencyOverrides, setCurrencyOverrides] = useState<
    Map<number, string>
  >(new Map());
  const [selectedBillHandles, setSelectedBillHandles] = useState<Set<number>>(
    new Set(),
  );
  const [options, setOptions] = useState<MnyImportOptionsInput>({});

  // The file is kept so a password retry can re-upload it without asking the
  // user to pick it again.
  const pendingFile = useRef<File | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Set once a start request carrying the wipe has been accepted. The wipe runs
  // server-side before the job row exists, so it has already happened by then --
  // see `wipeExistingData` in `buildOptions`.
  const wipePerformed = useRef(false);
  // What `reset` needs to know to clean up the server's staged copy, without
  // making `reset` change identity on every preview and job update.
  const staged = useRef<{ preview: MnyPreview | null; job: MnyImportJob | null }>({
    preview: null,
    job: null,
  });
  useEffect(() => {
    staged.current = { preview, job };
  }, [preview, job]);

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  // Polling must not outlive the page: a wizard left mid-import would otherwise
  // keep hitting the endpoint from a detached component.
  useEffect(() => stopPolling, [stopPolling]);

  const beginPolling = useCallback(
    (jobId: string) => {
      stopPolling();
      pollTimer.current = setInterval(() => {
        void client
          .getJob(jobId)
          .then((latest) => {
            setJob(latest);
            if (latest.status === 'completed' || latest.status === 'failed') {
              stopPolling();
            }
          })
          // A dropped poll is not a failed import: the next tick tries again.
          // The server decides a job is really dead -- the poll endpoint reaps
          // this user's stale jobs before it reads, so a worker that died comes
          // back as `failed` + retryable on a subsequent tick, not as a
          // progress bar that never moves.
          .catch(() => undefined);
      }, MNY_POLL_INTERVAL_MS);
    },
    [client, stopPolling],
  );

  const upload = useCallback(
    async (file: File, password?: string): Promise<boolean> => {
      pendingFile.current = file;
      setIsUploading(true);
      setUploadError(null);

      try {
        const parsed = await client.parse(file, password);
        setPreview(parsed);
        setOptions(parsed.options);
        setExcludedHandles(new Set());
        setCurrencyOverrides(new Map());
        // Detected-active candidates start ticked: the detection is the
        // recommendation and the checkboxes are the user's veto over it.
        setSelectedBillHandles(
          new Set(parsed.bills.map((bill) => bill.handle)),
        );
        setPasswordPrompt(null);
        return true;
      } catch (error) {
        const code = getErrorCode(error);
        if (code === PASSWORD_REQUIRED || code === PASSWORD_INCORRECT) {
          // The distinction is the whole point of the taxonomy: one asks for a
          // password, the other says the password was wrong.
          setPasswordPrompt({ retry: code === PASSWORD_INCORRECT });
          setUploadError(
            code === PASSWORD_INCORRECT
              ? { code, message: getErrorMessage(error, '') }
              : null,
          );
          return false;
        }
        setPasswordPrompt(null);
        setUploadError({
          code,
          message: getErrorMessage(error, ''),
          ...(isRequestFailure(error) ? { requestFailed: true } : {}),
        });
        return false;
      } finally {
        setIsUploading(false);
      }
    },
    [client],
  );

  /**
   * The password prompt's submit path. The file is held from the first attempt
   * so a user who typed the wrong password does not have to pick it again.
   */
  const retryWithPassword = useCallback(
    (password: string): Promise<boolean> => {
      const file = pendingFile.current;
      return file ? upload(file, password) : Promise.resolve(false);
    },
    [upload],
  );

  const toggleAccount = useCallback((handle: number) => {
    setExcludedHandles((current) => {
      const next = new Set(current);
      if (next.has(handle)) {
        next.delete(handle);
      } else {
        next.add(handle);
      }
      return next;
    });
  }, []);

  const setAllAccounts = useCallback(
    (include: boolean) => {
      setExcludedHandles(
        include
          ? new Set<number>()
          : new Set(
              (preview?.accounts ?? [])
                .map((account) => account.handle)
                .filter((handle): handle is number => handle !== null),
            ),
      );
    },
    [preview],
  );

  const setAccountCurrency = useCallback(
    (handle: number, currencyCode: string | null) => {
      setCurrencyOverrides((current) => {
        const next = new Map(current);
        if (currencyCode === null) {
          next.delete(handle);
        } else {
          next.set(handle, currencyCode);
        }
        return next;
      });
    },
    [],
  );

  const toggleBill = useCallback((handle: number) => {
    setSelectedBillHandles((current) => {
      const next = new Set(current);
      if (next.has(handle)) {
        next.delete(handle);
      } else {
        next.add(handle);
      }
      return next;
    });
  }, []);

  const setAllBills = useCallback(
    (include: boolean) => {
      setSelectedBillHandles(
        include
          ? new Set((preview?.bills ?? []).map((bill) => bill.handle))
          : new Set<number>(),
      );
    },
    [preview],
  );

  const setOption = useCallback(
    <K extends keyof MnyImportOptionsInput>(
      key: K,
      value: MnyImportOptionsInput[K],
    ) => {
      setOptions((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const setRename = useCallback((rename: MnyRename) => {
    setOptions((current) => ({
      ...current,
      renames: [
        ...(current.renames ?? []).filter(
          (entry) =>
            entry.kind !== rename.kind || entry.handle !== rename.handle,
        ),
        rename,
      ],
    }));
  }, []);

  /**
   * Sends only the accounts the user actually changed. An account absent from
   * the list takes the server's defaults, so a 56-account file with no edits
   * sends an empty array rather than 56 redundant entries.
   */
  const buildOptions = useCallback((): MnyImportOptionsInput => {
    const touched = new Set<number>([
      ...excludedHandles,
      ...currencyOverrides.keys(),
    ]);

    return {
      ...options,
      // The wipe happens in `start`, outside the job body, so a Retry after a
      // failed import must not ask for it again: the data is already gone, and
      // repeating it would fail re-authentication -- Retry collects no password,
      // by design, because it is one click on a failure screen.
      wipeExistingData: wipePerformed.current
        ? false
        : (options.wipeExistingData ?? false),
      accounts: [...touched].map((handle) => ({
        handle,
        include: !excludedHandles.has(handle),
        currencyOverride: currencyOverrides.get(handle) ?? null,
      })),
      // Always explicit, including when empty: omitting the field would mean
      // "every candidate" server-side, which is the opposite of unticking all.
      bills: [...selectedBillHandles],
    };
  }, [options, excludedHandles, currencyOverrides, selectedBillHandles]);

  const startWith = useCallback(
    async (stagedFileId: string, wipePassword?: string): Promise<boolean> => {
      setIsStarting(true);
      setUploadError(null);
      const requestOptions = buildOptions();
      try {
        const started = await client.start(
          stagedFileId,
          requestOptions,
          wipePassword ? { password: wipePassword } : undefined,
        );
        if (requestOptions.wipeExistingData) {
          wipePerformed.current = true;
        }
        setJob(started);
        beginPolling(started.id);
        return true;
      } catch (error) {
        setUploadError({
          code: getErrorCode(error),
          message: getErrorMessage(error, ''),
          ...(isRequestFailure(error) ? { requestFailed: true } : {}),
        });
        return false;
      } finally {
        setIsStarting(false);
      }
    },
    [beginPolling, buildOptions, client],
  );

  const start = useCallback(
    (wipePassword?: string) =>
      preview
        ? startWith(preview.stagedFileId, wipePassword)
        : Promise.resolve(false),
    [preview, startWith],
  );

  /** A retry is a new job over the same staged file -- no re-upload. */
  const retry = useCallback(() => {
    setJob(null);
    return preview ? startWith(preview.stagedFileId) : Promise.resolve(false);
  }, [preview, startWith]);

  const cancelPasswordPrompt = useCallback(() => {
    setPasswordPrompt(null);
    setUploadError(null);
    pendingFile.current = null;
  }, []);

  const reset = useCallback(() => {
    stopPolling();
    // A staged file nothing ever started (Back from the review, a new file
    // chosen) or whose job failed is dropped now rather than at the 24 h sweep.
    // A running or finished job owns its file. Best effort: the sweep is the
    // backstop, so a failed discard is not an error to show.
    const { preview: stagedPreview, job: stagedJob } = staged.current;
    if (stagedPreview && (stagedJob === null || stagedJob.status === 'failed')) {
      void Promise.resolve()
        .then(() => client.discardStagedFile(stagedPreview.stagedFileId))
        .catch(() => undefined);
    }
    staged.current = { preview: null, job: null };
    setPreview(null);
    setJob(null);
    setPasswordPrompt(null);
    setUploadError(null);
    setExcludedHandles(new Set());
    setCurrencyOverrides(new Map());
    setSelectedBillHandles(new Set());
    setOptions({});
    pendingFile.current = null;
    wipePerformed.current = false;
  }, [client, stopPolling]);

  return {
    preview,
    job,
    isUploading,
    isStarting,
    passwordPrompt,
    uploadError,
    excludedHandles,
    currencyOverrides,
    selectedBillHandles,
    options,
    upload,
    retryWithPassword,
    toggleAccount,
    setAllAccounts,
    setAccountCurrency,
    toggleBill,
    setAllBills,
    setOption,
    setRename,
    start,
    retry,
    cancelPasswordPrompt,
    reset,
  };
}
