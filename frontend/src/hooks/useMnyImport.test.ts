import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { AxiosError } from 'axios';
import { useMnyImport } from './useMnyImport';
import { mnyImportApi } from '@/lib/import-mny';
import type { MnyImportJob, MnyPreview } from '@/lib/import-mny';

vi.mock('@/lib/import-mny', () => ({
  mnyImportApi: {
    parse: vi.fn(),
    start: vi.fn(),
    getJob: vi.fn(),
    discardStagedFile: vi.fn(),
  },
}));

const mockedApi = vi.mocked(mnyImportApi);

function preview(overrides: Partial<MnyPreview> = {}): MnyPreview {
  return {
    stagedFileId: 'staged-1',
    filename: 'finances.mny',
    sizeBytes: 1024,
    era: 'moneyPlus',
    passwordProtected: false,
    baseCurrency: 'USD',
    accounts: [
      {
        key: 'acct-1',
        handle: 1,
        name: 'Chequing',
        moneyName: 'Chequing',
        accountType: 'CHEQUING',
        accountSubType: null,
        currencyCode: 'USD',
        transactionCount: 10,
        investmentCount: 0,
        openingBalance: 0,
        finalBalance: 100,
        closed: false,
        favourite: false,
      },
      {
        key: 'acct-2',
        handle: 2,
        name: 'Savings',
        moneyName: 'Savings',
        accountType: 'SAVINGS',
        accountSubType: null,
        currencyCode: 'USD',
        investmentCount: 0,
        transactionCount: 5,
        openingBalance: 0,
        finalBalance: 50,
        closed: false,
        favourite: false,
      },
    ],
    bills: [],
    counts: {
      accountsIncluded: 2,
      accountsInFile: 2,
      payeesToCreate: 1,
      payeesInFile: 2,
      categoriesToCreate: 1,
      categoriesInFile: 2,
      tagsToCreate: 0,
      tagsInFile: 0,
      transactionsToCreate: 15,
      transfersToLink: 0,
      transactionsSkipped: 0,
      securitiesToCreate: 0,
      securitiesInFile: 0,
      investmentsToCreate: 0,
      investmentsSkipped: 0,
      shareTransfersPaired: 0,
      pricesToImport: 0,
      exchangeRatesToImport: 0,
      billsDetected: 0,
      billsSkipped: 0,
    },
    fileCounts: {
      accounts: 2,
      payees: 2,
      categories: 2,
      securities: 0,
      securityPrices: 0,
      exchangeRates: 0,
      bills: 0,
      transactions: 15,
    },
    missingTables: [],
    missingFields: [],
    warnings: [],
    options: {
      wipeExistingData: false,
      referencedOnlyPayees: true,
      referencedOnlyCategories: true,
      importClosedAccounts: true,
      importPrices: true,
      importExchangeRates: true,
      accounts: [],
      bills: [],
    },
    ...overrides,
  };
}

function job(overrides: Partial<MnyImportJob> = {}): MnyImportJob {
  return {
    id: 'job-1',
    status: 'running',
    progress: null,
    result: null,
    errorKey: null,
    retryable: false,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

/** An axios error shaped the way the backend's error taxonomy arrives. */
function apiError(errorCode: string, message = 'boom'): AxiosError {
  const error = new AxiosError(message);
  error.response = {
    data: { message, errorCode },
    status: 400,
    statusText: 'Bad Request',
    headers: {},
    config: {} as never,
  };
  return error;
}

const file = new File(['bytes'], 'finances.mny');

describe('useMnyImport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.parse.mockResolvedValue(preview());
    mockedApi.start.mockResolvedValue(job());
    mockedApi.getJob.mockResolvedValue(job());
  });

  afterEach(() => vi.useRealTimers());

  describe('upload', () => {
    it('keeps the preview and the server-computed option defaults', async () => {
      const { result } = renderHook(() => useMnyImport());

      await act(async () => {
        expect(await result.current.upload(file)).toBe(true);
      });

      expect(result.current.preview?.stagedFileId).toBe('staged-1');
      expect(result.current.options.referencedOnlyPayees).toBe(true);
    });

    it('prompts for a password when the file is protected', async () => {
      mockedApi.parse.mockRejectedValue(apiError('mnyPasswordRequired'));
      const { result } = renderHook(() => useMnyImport());

      await act(async () => {
        expect(await result.current.upload(file)).toBe(false);
      });

      expect(result.current.passwordPrompt).toEqual({ retry: false });
      // Nothing to show yet: the file needing a password is not an error.
      expect(result.current.uploadError).toBeNull();
    });

    it('distinguishes a wrong password from a missing one', async () => {
      mockedApi.parse.mockRejectedValue(apiError('mnyPasswordIncorrect'));
      const { result } = renderHook(() => useMnyImport());

      await act(async () => {
        await result.current.upload(file, 'wrong');
      });

      expect(result.current.passwordPrompt).toEqual({ retry: true });
      expect(result.current.uploadError?.code).toBe('mnyPasswordIncorrect');
    });

    it('reports any other failure without prompting for a password', async () => {
      mockedApi.parse.mockRejectedValue(
        apiError('mnyUnsupportedVersion', 'Money 97 file'),
      );
      const { result } = renderHook(() => useMnyImport());

      await act(async () => {
        await result.current.upload(file);
      });

      expect(result.current.passwordPrompt).toBeNull();
      expect(result.current.uploadError).toEqual({
        code: 'mnyUnsupportedVersion',
        message: 'Money 97 file',
      });
    });

    it.each([
      ['a timeout with no response', undefined],
      ['a proxy 502', 502],
      ['a 503', 503],
      ['a 504', 504],
    ])('marks %s as a request that failed, not a refused file', async (_label, status) => {
      const error = new AxiosError('timeout of 300000ms exceeded');
      if (status !== undefined) {
        error.response = {
          data: { error: 'Backend unavailable' },
          status,
          statusText: 'Bad Gateway',
          headers: {},
          config: {} as never,
        };
      }
      mockedApi.parse.mockRejectedValueOnce(error);
      const { result } = renderHook(() => useMnyImport());

      await act(async () => {
        await result.current.upload(file);
      });

      expect(result.current.uploadError?.requestFailed).toBe(true);
    });

    it('does not mark a refusal with a code, or a plain 400, as a failed request', async () => {
      mockedApi.parse.mockRejectedValueOnce(apiError('kmyCorruptFile'));
      const { result } = renderHook(() => useMnyImport());

      await act(async () => {
        await result.current.upload(file);
      });

      expect(result.current.uploadError?.requestFailed).toBeUndefined();
    });

    it('retries with a password without asking for the file again', async () => {
      mockedApi.parse.mockRejectedValueOnce(apiError('mnyPasswordRequired'));
      const { result } = renderHook(() => useMnyImport());

      await act(async () => {
        await result.current.upload(file);
      });
      await act(async () => {
        expect(await result.current.retryWithPassword('hunter2')).toBe(true);
      });

      expect(mockedApi.parse).toHaveBeenLastCalledWith(file, 'hunter2');
      expect(result.current.passwordPrompt).toBeNull();
    });

    it('cannot retry before a file has been chosen', async () => {
      const { result } = renderHook(() => useMnyImport());

      await act(async () => {
        expect(await result.current.retryWithPassword('x')).toBe(false);
      });

      expect(mockedApi.parse).not.toHaveBeenCalled();
    });
  });

  describe('account selection', () => {
    it('sends only the accounts the user actually changed', async () => {
      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });

      act(() => result.current.toggleAccount(2));
      await act(async () => {
        await result.current.start();
      });

      // A 56-account file with one edit must not send 56 entries.
      expect(mockedApi.start).toHaveBeenCalledWith(
        'staged-1',
        expect.objectContaining({
          accounts: [{ handle: 2, include: false, currencyOverride: null }],
        }),
        undefined,
      );
    });

    it('toggles an account back on', async () => {
      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });

      act(() => result.current.toggleAccount(2));
      act(() => result.current.toggleAccount(2));

      expect(result.current.excludedHandles.size).toBe(0);
    });

    it('excludes or includes every account at once', async () => {
      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });

      act(() => result.current.setAllAccounts(false));
      expect([...result.current.excludedHandles].sort()).toEqual([1, 2]);

      act(() => result.current.setAllAccounts(true));
      expect(result.current.excludedHandles.size).toBe(0);
    });

    it('records and clears a currency override', async () => {
      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });

      act(() => result.current.setAccountCurrency(1, 'CAD'));
      expect(result.current.currencyOverrides.get(1)).toBe('CAD');

      act(() => result.current.setAccountCurrency(1, null));
      expect(result.current.currencyOverrides.has(1)).toBe(false);
    });

    it('sends a currency override for an account that is still included', async () => {
      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });

      act(() => result.current.setAccountCurrency(1, 'CAD'));
      await act(async () => {
        await result.current.start();
      });

      expect(mockedApi.start).toHaveBeenCalledWith(
        'staged-1',
        expect.objectContaining({
          accounts: [{ handle: 1, include: true, currencyOverride: 'CAD' }],
        }),
        undefined,
      );
    });
  });

  describe('bill selection', () => {
    /** A preview carrying two detected-active bills. */
    const withBills = () => {
      mockedApi.parse.mockResolvedValue(
        preview({
          bills: [
            {
              handle: 7,
              name: 'Hydro One',
              accountName: 'Chequing',
              amount: -95.5,
              currencyCode: 'USD',
              frequency: 'MONTHLY',
              approximate: false,
              nextDueDate: '2026-08-02',
              isTransfer: false,
              isInvestment: false,
              splitCount: 0,
              status: 0,
            },
            {
              handle: 8,
              name: 'Rent',
              accountName: 'Chequing',
              amount: -1500,
              currencyCode: 'USD',
              frequency: 'MONTHLY',
              approximate: false,
              nextDueDate: '2026-08-01',
              isTransfer: false,
              isInvestment: false,
              splitCount: 0,
              status: 0,
            },
          ],
        }),
      );
    };

    it('starts with every detected-active bill ticked', async () => {
      withBills();
      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });

      expect([...result.current.selectedBillHandles].sort()).toEqual([7, 8]);
    });

    it('sends only the ticked bills', async () => {
      withBills();
      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });

      act(() => result.current.toggleBill(8));
      await act(async () => {
        await result.current.start();
      });

      expect(mockedApi.start).toHaveBeenCalledWith(
        'staged-1',
        expect.objectContaining({ bills: [7] }),
        undefined,
      );
    });

    it('sends an explicit empty list when every bill is unticked', async () => {
      // Omitting the field would mean "import every candidate" server-side,
      // which is the opposite of what unticking all of them asks for.
      withBills();
      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });

      act(() => result.current.setAllBills(false));
      await act(async () => {
        await result.current.start();
      });

      expect(mockedApi.start).toHaveBeenCalledWith(
        'staged-1',
        expect.objectContaining({ bills: [] }),
        undefined,
      );
    });

    it('re-ticks every bill at once', async () => {
      withBills();
      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });

      act(() => result.current.setAllBills(false));
      expect(result.current.selectedBillHandles.size).toBe(0);

      act(() => result.current.setAllBills(true));
      expect([...result.current.selectedBillHandles].sort()).toEqual([7, 8]);
    });
  });

  describe('options', () => {
    it('overrides a single option and leaves the rest', async () => {
      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });

      act(() => result.current.setOption('referencedOnlyPayees', false));

      expect(result.current.options.referencedOnlyPayees).toBe(false);
      expect(result.current.options.referencedOnlyCategories).toBe(true);
    });
  });

  describe('start and polling', () => {
    it('does nothing without a preview', async () => {
      const { result } = renderHook(() => useMnyImport());

      await act(async () => {
        expect(await result.current.start()).toBe(false);
      });
      expect(mockedApi.start).not.toHaveBeenCalled();
    });

    it('forwards a wipe password on the start request only', async () => {
      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });

      await act(async () => {
        await result.current.start('hunter2');
      });

      expect(mockedApi.start).toHaveBeenCalledWith(
        'staged-1',
        expect.anything(),
        { password: 'hunter2' },
      );
    });

    it('reports a failure to start, e.g. a wrong wipe password', async () => {
      mockedApi.start.mockRejectedValue(
        apiError('UNAUTHORIZED', 'Invalid password'),
      );
      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });

      await act(async () => {
        expect(await result.current.start('wrong')).toBe(false);
      });

      expect(result.current.uploadError?.message).toBe('Invalid password');
    });

    it('polls until the job finishes, then stops', async () => {
      vi.useFakeTimers();
      mockedApi.getJob
        .mockResolvedValueOnce(
          job({ progress: { phase: 'transactions', processed: 5, total: 15 } }),
        )
        .mockResolvedValueOnce(job({ status: 'completed' }));

      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });
      await act(async () => {
        await result.current.start();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(result.current.job?.progress?.processed).toBe(5);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(result.current.job?.status).toBe('completed');

      const callsAtFinish = mockedApi.getJob.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(mockedApi.getJob.mock.calls.length).toBe(callsAtFinish);
    });

    it('keeps polling after a dropped poll rather than giving up', async () => {
      vi.useFakeTimers();
      mockedApi.getJob
        .mockRejectedValueOnce(new Error('network blip'))
        .mockResolvedValueOnce(job({ status: 'completed' }));

      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });
      await act(async () => {
        await result.current.start();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      expect(result.current.job?.status).toBe('completed');
    });

    it('stops polling a failed job', async () => {
      vi.useFakeTimers();
      mockedApi.getJob.mockResolvedValue(
        job({ status: 'failed', errorKey: 'mnyImportFailed', retryable: true }),
      );

      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });
      await act(async () => {
        await result.current.start();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });

      const calls = mockedApi.getJob.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(mockedApi.getJob.mock.calls.length).toBe(calls);
    });

    it('stops polling when the component unmounts', async () => {
      vi.useFakeTimers();
      const { result, unmount } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });
      await act(async () => {
        await result.current.start();
      });

      unmount();
      const calls = mockedApi.getJob.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });

      expect(mockedApi.getJob.mock.calls.length).toBe(calls);
    });
  });

  describe('retry', () => {
    it('starts a new job over the same staged file, with no re-upload', async () => {
      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });
      await act(async () => {
        await result.current.start();
      });

      mockedApi.parse.mockClear();
      await act(async () => {
        expect(await result.current.retry()).toBe(true);
      });

      expect(mockedApi.parse).not.toHaveBeenCalled();
      expect(mockedApi.start).toHaveBeenLastCalledWith(
        'staged-1',
        expect.anything(),
        undefined,
      );
    });

    it('cannot retry without a staged file', async () => {
      const { result } = renderHook(() => useMnyImport());

      await act(async () => {
        expect(await result.current.retry()).toBe(false);
      });
    });

    it('does not ask for the wipe a second time when retrying', async () => {
      // The wipe runs server-side in `start`, before the job row exists, so by
      // the time a job can fail the data is already gone. Retry collects no
      // password -- it is one click on a failure screen -- so repeating the
      // request would fail re-authentication and the user would be stuck on a
      // retryable failure they cannot retry.
      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });
      act(() => result.current.setOption('wipeExistingData', true));

      await act(async () => {
        await result.current.start('hunter2');
      });
      expect(mockedApi.start).toHaveBeenLastCalledWith(
        'staged-1',
        expect.objectContaining({ wipeExistingData: true }),
        { password: 'hunter2' },
      );

      await act(async () => {
        await result.current.retry();
      });

      expect(mockedApi.start).toHaveBeenLastCalledWith(
        'staged-1',
        expect.objectContaining({ wipeExistingData: false }),
        undefined,
      );
    });

    it('still wipes on a retry when the first start never reached the server', async () => {
      // A start the backend refused wiped nothing, so the option has to survive.
      mockedApi.start.mockRejectedValueOnce(
        apiError('mnyImportAlreadyRunning', 'Already running'),
      );
      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });
      act(() => result.current.setOption('wipeExistingData', true));

      await act(async () => {
        expect(await result.current.start('hunter2')).toBe(false);
      });
      await act(async () => {
        await result.current.start('hunter2');
      });

      expect(mockedApi.start).toHaveBeenLastCalledWith(
        'staged-1',
        expect.objectContaining({ wipeExistingData: true }),
        { password: 'hunter2' },
      );
    });
  });

  describe('reset', () => {
    it('clears everything so the wizard can start again', async () => {
      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });
      act(() => result.current.toggleAccount(1));

      act(() => result.current.reset());

      await waitFor(() => {
        expect(result.current.preview).toBeNull();
        expect(result.current.job).toBeNull();
        expect(result.current.excludedHandles.size).toBe(0);
        expect(result.current.options).toEqual({});
      });
    });

    it('discards a staged file nothing started', async () => {
      mockedApi.discardStagedFile.mockResolvedValue(undefined);
      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });

      await act(async () => result.current.reset());

      expect(mockedApi.discardStagedFile).toHaveBeenCalledWith('staged-1');
    });

    it('discards the staged file of a failed job, and keeps that of a running or finished one', async () => {
      mockedApi.discardStagedFile.mockResolvedValue(undefined);
      for (const [status, discarded] of [
        ['failed', true],
        ['running', false],
        ['completed', false],
      ] as const) {
        mockedApi.discardStagedFile.mockClear();
        mockedApi.start.mockResolvedValue(job({ status }));
        const { result, unmount } = renderHook(() => useMnyImport());
        await act(async () => {
          await result.current.upload(file);
        });
        await act(async () => {
          await result.current.start();
        });

        await act(async () => result.current.reset());

        expect(mockedApi.discardStagedFile).toHaveBeenCalledTimes(discarded ? 1 : 0);
        unmount();
      }
    });

    it('does not surface a failed discard', async () => {
      mockedApi.discardStagedFile.mockRejectedValue(new Error('gone'));
      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });

      await act(async () => result.current.reset());

      expect(result.current.uploadError).toBeNull();
    });

    it('cancels the password prompt without keeping the file', async () => {
      mockedApi.parse.mockRejectedValue(apiError('mnyPasswordRequired'));
      const { result } = renderHook(() => useMnyImport());
      await act(async () => {
        await result.current.upload(file);
      });

      act(() => result.current.cancelPasswordPrompt());
      expect(result.current.passwordPrompt).toBeNull();

      await act(async () => {
        expect(await result.current.retryWithPassword('x')).toBe(false);
      });
    });
  });
});

describe('useMnyImport with another client', () => {
  const fake = {
    parse: vi.fn(),
    start: vi.fn(),
    getJob: vi.fn(),
    discardStagedFile: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    fake.parse.mockResolvedValue(preview({ filename: 'budget.kmy' }));
    fake.start.mockResolvedValue(job());
    fake.getJob.mockResolvedValue(job());
  });

  afterEach(() => vi.useRealTimers());

  it('uploads, starts and polls through the client it was given, never the Money one', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useMnyImport(fake));

    await act(async () => {
      expect(await result.current.upload(new File(['x'], 'budget.kmy'))).toBe(true);
    });
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(fake.parse).toHaveBeenCalledWith(expect.any(File), undefined);
    expect(fake.start).toHaveBeenCalledWith('staged-1', expect.anything(), undefined);
    expect(fake.getJob).toHaveBeenCalledWith('job-1');
    expect(mockedApi.parse).not.toHaveBeenCalled();
    expect(mockedApi.start).not.toHaveBeenCalled();
    expect(mockedApi.getJob).not.toHaveBeenCalled();
  });

  it('reports a refused file as an upload error and never opens the password prompt', async () => {
    fake.parse.mockRejectedValue(apiError('kmyEncryptedFile', 'encrypted'));
    const { result } = renderHook(() => useMnyImport(fake));

    await act(async () => {
      expect(await result.current.upload(new File(['x'], 'budget.kmy'))).toBe(false);
    });

    expect(result.current.passwordPrompt).toBeNull();
    expect(result.current.uploadError).toEqual({ code: 'kmyEncryptedFile', message: 'encrypted' });
  });
});
