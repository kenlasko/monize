import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@/test/render';
import userEvent from '@testing-library/user-event';
import toast from 'react-hot-toast';
import { RateHistoryCoverage } from './RateHistoryCoverage';
import { usePreferencesStore } from '@/store/preferencesStore';
import type { UserPreferences } from '@/types/auth';

const getRateCoverage = vi.fn();
const fillRateGaps = vi.fn();

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getRateCoverage: (...args: any[]) => getRateCoverage(...args),
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

async function renderSection(
  code = 'EUR',
  props: Partial<Parameters<typeof RateHistoryCoverage>[0]> = {},
) {
  await act(async () => {
    render(<RateHistoryCoverage code={code} {...props} />);
  });
}

describe('RateHistoryCoverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePreferencesStore.setState({
      preferences: { defaultCurrency: 'PLN' } as UserPreferences,
    });
    getRateCoverage.mockResolvedValue(coverage);
    fillRateGaps.mockResolvedValue(filled);
  });

  describe('the stored span', () => {
    it('shows the stored span and observation count', async () => {
      await renderSection();

      // A sub-heading of the currency form's own by default.
      expect(screen.getByRole('heading', { level: 3, name: 'Rate history' })).toBeInTheDocument();

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
    });

    it('takes the heading it is given', async () => {
      await renderSection('EUR', { title: 'Stored Rates', headingLevel: 'h2' });

      expect(screen.getByRole('heading', { level: 2, name: 'Stored Rates' })).toBeInTheDocument();
      expect(screen.queryByText('Rate history')).not.toBeInTheDocument();
    });

    it('never renders a response for the currency it no longer shows', async () => {
      let releaseEur: (value: unknown) => void = () => {};
      getRateCoverage.mockImplementation((code: string) =>
        code === 'EUR'
          ? new Promise((resolve) => {
              releaseEur = resolve;
            })
          : Promise.resolve({ ...coverage, from: 'USD', observations: 42 }),
      );

      const { rerender } = render(<RateHistoryCoverage code="EUR" />);
      await act(async () => {
        rerender(<RateHistoryCoverage code="USD" />);
      });
      // The EUR read lands after the panel moved on to USD.
      await act(async () => {
        releaseEur(coverage);
      });

      expect(await screen.findByText(/42 observations/)).toBeInTheDocument();
      expect(screen.queryByText(/180 observations/)).not.toBeInTheDocument();
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
      expect(await screen.findByText(/420 observations/)).toBeInTheDocument();
    });

    it('tells the surface showing the history to re-read it once rates were stored', async () => {
      const onFilled = vi.fn();
      await renderSection('EUR', { onFilled });

      await userEvent.click(screen.getByRole('button', { name: FILL_BUTTON }));

      await waitFor(() => expect(onFilled).toHaveBeenCalledTimes(1));
    });

    it('leaves the history alone when the fill stored nothing', async () => {
      const onFilled = vi.fn();
      fillRateGaps.mockResolvedValue({ ...filled, stored: 0, windowsPlanned: 0 });
      await renderSection('EUR', { onFilled });

      await userEvent.click(screen.getByRole('button', { name: FILL_BUTTON }));

      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(onFilled).not.toHaveBeenCalled();
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
