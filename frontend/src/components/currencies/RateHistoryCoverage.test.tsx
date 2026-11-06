import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@/test/render';
import userEvent from '@testing-library/user-event';
import toast from 'react-hot-toast';
import { RateHistoryCoverage } from './RateHistoryCoverage';
import { usePreferencesStore } from '@/store/preferencesStore';
import type { UserPreferences } from '@/types/auth';

const getRateCoverage = vi.fn();
const getStoredRates = vi.fn();
const fillRateGaps = vi.fn();

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getRateCoverage: (...args: any[]) => getRateCoverage(...args),
    getStoredRates: (...args: any[]) => getStoredRates(...args),
    fillRateGaps: (...args: any[]) => fillRateGaps(...args),
    getLatestRates: () => Promise.resolve([]),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const coverage = {
  from: 'EUR',
  to: 'PLN',
  earliestDate: '2026-01-02',
  latestDate: '2026-09-16',
  observations: 180,
};

const storedRates = {
  from: 'EUR',
  to: 'PLN',
  rates: [
    {
      rateDate: '2026-09-16',
      rate: 4.25,
      source: 'yahoo_finance',
      inverted: false,
    },
    {
      rateDate: '2026-09-15',
      rate: 4.3,
      source: 'mny_import',
      inverted: false,
    },
    {
      rateDate: '2026-09-14',
      rate: 4.28,
      source: 'frankfurter',
      inverted: false,
    },
    {
      rateDate: '2026-09-13',
      rate: 4.27,
      source: 'yahoo_crypto',
      inverted: false,
    },
  ],
  truncated: false,
  limit: 2000,
};

const filled = {
  from: 'EUR',
  to: 'PLN',
  usedFrom: '2026-01-01',
  spanEnd: '2026-09-17',
  unresolvableDays: 260,
  sparseDays: 260,
  windowsPlanned: 1,
  windowsFetched: 1,
  windowsSkipped: 0,
  windowsUnanswered: 0,
  windowsRemaining: 0,
  stored: 240,
  earliestDate: '2025-12-18',
  providerHasNothingBefore: null,
};

const FILL_BUTTON = 'Fill gaps in rate history';

async function renderSection(code = 'EUR', showStoredRates = true) {
  await act(async () => {
    render(
      <RateHistoryCoverage code={code} showStoredRates={showStoredRates} />,
    );
  });
}

describe('RateHistoryCoverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePreferencesStore.setState({
      preferences: { defaultCurrency: 'PLN' } as UserPreferences,
    });
    getRateCoverage.mockResolvedValue(coverage);
    getStoredRates.mockResolvedValue(storedRates);
    fillRateGaps.mockResolvedValue(filled);
  });

  describe('the stored span', () => {
    it('shows the stored span and observation count', async () => {
      await renderSection();

      expect(getRateCoverage).toHaveBeenCalledWith('EUR');
      expect(await screen.findByText(/Stored history:/)).toHaveTextContent(
        '180 observations',
      );
    });

    it('says so when the pair has no stored history', async () => {
      getRateCoverage.mockResolvedValue({
        ...coverage,
        earliestDate: null,
        latestDate: null,
        observations: 0,
      });

      await renderSection();

      expect(
        await screen.findByText('No stored history for EUR->PLN'),
      ).toBeInTheDocument();
    });

    it('reports a coverage read that failed rather than an empty history', async () => {
      getRateCoverage.mockRejectedValue(new Error('boom'));

      await renderSection();

      expect(
        await screen.findByText('Could not read the stored rate history'),
      ).toBeInTheDocument();
      expect(
        screen.queryByText('No stored history for EUR->PLN'),
      ).not.toBeInTheDocument();
    });

    it('renders nothing for the reader’s own reporting currency', async () => {
      await renderSection('PLN');

      expect(screen.queryByText('Rate history')).not.toBeInTheDocument();
      expect(getRateCoverage).not.toHaveBeenCalled();
      expect(getStoredRates).not.toHaveBeenCalled();
    });
  });

  describe('the list of stored rates', () => {
    it('lists the stored rates newest first, with their source', async () => {
      await renderSection();

      expect(getStoredRates).toHaveBeenCalledWith('EUR');
      const rows = await screen.findAllByRole('row');
      // The header row, then the rates in the order the server sent them.
      expect(rows[1]).toHaveTextContent('4.250000');
      expect(rows[1]).toHaveTextContent('Yahoo Finance');
      expect(rows[2]).toHaveTextContent('4.300000');
      expect(rows[2]).toHaveTextContent('Money import');
      expect(rows[3]).toHaveTextContent('4.280000');
      expect(rows[3]).toHaveTextContent('Frankfurter (ECB)');
      expect(rows[4]).toHaveTextContent('4.270000');
      expect(rows[4]).toHaveTextContent('Crypto pairs (Yahoo)');
    });

    it('says which direction the column is in', async () => {
      await renderSection();

      expect(
        await screen.findByText('Shown as PLN per 1 EUR.'),
      ).toBeInTheDocument();
    });

    it('marks a rate derived from a row stored the other way round', async () => {
      getStoredRates.mockResolvedValue({
        ...storedRates,
        rates: [{ ...storedRates.rates[0], inverted: true }],
      });

      await renderSection();

      expect(await screen.findByText('inverted')).toBeInTheDocument();
    });

    it('renders a rate it cannot state as unknown, never as zero', async () => {
      getStoredRates.mockResolvedValue({
        ...storedRates,
        rates: [{ ...storedRates.rates[0], rate: null, source: null }],
      });

      await renderSection();

      const rows = await screen.findAllByRole('row');
      expect(rows[1]).toHaveTextContent('Unknown');
      expect(rows[1]).not.toHaveTextContent('0.000000');
    });

    it('says the list could not be read rather than showing an empty one', async () => {
      getStoredRates.mockRejectedValue(new Error('boom'));

      await renderSection();

      expect(
        await screen.findByText('Could not read the stored rates'),
      ).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      // The summary beside it still read fine, and still says so.
      expect(screen.getByText(/Stored history:/)).toBeInTheDocument();
    });

    it('says when the server capped the list', async () => {
      getStoredRates.mockResolvedValue({ ...storedRates, truncated: true });

      await renderSection();

      expect(
        await screen.findByText(
          'Showing the 2,000 most recent stored rates; older ones are not listed.',
        ),
      ).toBeInTheDocument();
    });

    it('neither fetches nor renders the list without the prop', async () => {
      await renderSection('EUR', false);

      expect(getRateCoverage).toHaveBeenCalledWith('EUR');
      expect(getStoredRates).not.toHaveBeenCalled();
      expect(screen.queryByText('Stored rates')).not.toBeInTheDocument();
    });

    it('never renders a response for the currency it no longer shows', async () => {
      let releaseEur: (value: unknown) => void = () => {};
      getStoredRates.mockImplementation((code: string) =>
        code === 'EUR'
          ? new Promise((resolve) => {
              releaseEur = resolve;
            })
          : Promise.resolve({
              ...storedRates,
              from: 'USD',
              rates: [
                {
                  rateDate: '2026-09-16',
                  rate: 3.9,
                  source: 'yahoo_finance',
                  inverted: false,
                },
              ],
            }),
      );

      const { rerender } = render(
        <RateHistoryCoverage code="EUR" showStoredRates />,
      );
      await act(async () => {
        rerender(<RateHistoryCoverage code="USD" showStoredRates />);
      });
      // The EUR read lands after the panel moved on to USD.
      await act(async () => {
        releaseEur(storedRates);
      });

      expect(await screen.findByText('3.900000')).toBeInTheDocument();
      expect(screen.queryByText('4.250000')).not.toBeInTheDocument();
    });
  });

  describe('filling the gaps', () => {
    it('fills the gaps, reports what was stored and re-reads', async () => {
      await renderSection();
      getRateCoverage.mockResolvedValue({
        ...coverage,
        earliestDate: '2025-12-18',
        observations: 420,
      });

      await userEvent.click(screen.getByRole('button', { name: FILL_BUTTON }));

      await waitFor(() => expect(fillRateGaps).toHaveBeenCalledWith('EUR'));
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining('Stored 240 rates'),
      );
      // The server decides what is stored, so the section re-reads rather than
      // patching its own state.
      await waitFor(() => expect(getRateCoverage).toHaveBeenCalledTimes(2));
      expect(getStoredRates).toHaveBeenCalledTimes(2);
      expect(await screen.findByText(/420 observations/)).toBeInTheDocument();
    });

    it('says how much is left when a bound stopped the fill early', async () => {
      fillRateGaps.mockResolvedValue({ ...filled, windowsRemaining: 3 });
      await renderSection();

      await userEvent.click(screen.getByRole('button', { name: FILL_BUTTON }));

      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith(
          expect.stringContaining('3 more gaps to fetch'),
        ),
      );
    });

    it('distinguishes a provider whose history starts later from a failure', async () => {
      fillRateGaps.mockResolvedValue({
        ...filled,
        stored: 0,
        earliestDate: null,
        providerHasNothingBefore: '2003-12-01',
      });
      await renderSection();

      await userEvent.click(screen.getByRole('button', { name: FILL_BUTTON }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          expect.stringContaining('The provider has no rates for EUR->PLN'),
        ),
      );
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('tells the reader to press again when a bound stopped an empty fill', async () => {
      // Nothing stored and the span not covered: "no new rates" alone would
      // read as a dead end rather than as work still to do.
      fillRateGaps.mockResolvedValue({
        ...filled,
        stored: 0,
        earliestDate: null,
        windowsRemaining: 2,
      });
      await renderSection();

      await userEvent.click(screen.getByRole('button', { name: FILL_BUTTON }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          expect.stringContaining('2 gaps are still to fetch'),
        ),
      );
    });

    it('says so when there was no gap to fill', async () => {
      fillRateGaps.mockResolvedValue({
        ...filled,
        stored: 0,
        windowsPlanned: 0,
        windowsFetched: 0,
        unresolvableDays: 0,
        sparseDays: 0,
      });
      await renderSection();

      await userEvent.click(screen.getByRole('button', { name: FILL_BUTTON }));

      // The claim is density, not mere convertibility: a month-end-only
      // history converts every date too, and this branch must not fire for it.
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith(
          'EUR->PLN already has a daily rate for every date your reports need',
        ),
      );
    });

    it('says so when nothing of the reader’s uses the currency', async () => {
      fillRateGaps.mockResolvedValue({
        ...filled,
        usedFrom: null,
        stored: 0,
        windowsPlanned: 0,
      });
      await renderSection();

      await userEvent.click(screen.getByRole('button', { name: FILL_BUTTON }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          expect.stringContaining('uses EUR'),
        ),
      );
    });

    it('surfaces the server message when the provider did not answer', async () => {
      fillRateGaps.mockRejectedValue({
        response: { data: { message: 'The exchange rate provider did not answer.' } },
      });
      await renderSection();

      await userEvent.click(screen.getByRole('button', { name: FILL_BUTTON }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          'The exchange rate provider did not answer.',
        ),
      );
    });

    it('disables the button while a fill is in flight', async () => {
      let release: (value: unknown) => void = () => {};
      fillRateGaps.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      await renderSection();
      const button = screen.getByRole('button', { name: FILL_BUTTON });

      await userEvent.click(button);

      expect(
        screen.getByRole('button', { name: 'Fetching missing rates...' }),
      ).toBeDisabled();
      await act(async () => {
        release(filled);
      });
    });
  });
});
