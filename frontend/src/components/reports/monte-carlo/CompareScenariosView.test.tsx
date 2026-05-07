import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, waitFor } from '@testing-library/react';
import { render, screen } from '@/test/render';
import { AxiosError, AxiosHeaders } from 'axios';
import type {
  MonteCarloScenario,
  SimulationResult,
} from '@/lib/monte-carlo';

// ─── Mocks ────────────────────────────────────────────────────────────

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  runSaved: vi.fn(),
}));
vi.mock('@/lib/monte-carlo', () => ({ monteCarloApi: mockApi }));

const mockCache = vi.hoisted(() => ({
  getCachedResult: vi.fn(),
  setCachedResult: vi.fn(),
  clearCachedResult: vi.fn(),
}));
vi.mock('@/lib/monte-carlo-cache', () => mockCache);

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(0)}`,
    defaultCurrency: 'USD',
  }),
}));

const mockExportToCsv = vi.hoisted(() => vi.fn());
vi.mock('@/lib/csv-export', () => ({ exportToCsv: mockExportToCsv }));

const mockRouter = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  prefetch: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  usePathname: () => '/reports/monte-carlo-simulation/compare',
  useSearchParams: () => new URLSearchParams(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────

const scenario = (overrides: Partial<MonteCarloScenario> = {}): MonteCarloScenario => ({
  id: 'a',
  name: 'Plan A',
  description: null,
  accountIds: ['acc-1'],
  startingValue: 100000,
  useCurrentBalance: true,
  yearsToRetirement: 25,
  annualContribution: 12000,
  contributionGrowthRate: 0.02,
  yearsInRetirement: 30,
  annualWithdrawal: 60000,
  expectedReturn: 0.07,
  volatility: 0.15,
  inflationRate: 0.025,
  showRealValues: false,
  useHistoricalReturns: false,
  simulationCount: 5000,
  targetValue: null,
  randomSeed: null,
  isFavourite: false,
  sortOrder: 0,
  lastRunAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  cashFlows: [],
  ...overrides,
});

const result = (): SimulationResult => ({
  yearLabels: ['2027', '2028'],
  percentiles: {
    p10: [110, 120],
    p25: [115, 130],
    p50: [120, 140],
    p75: [125, 150],
    p90: [130, 160],
  },
  finalDistribution: {
    min: 50,
    max: 300,
    mean: 165,
    median: 160,
    stdev: 30,
    depletionRate: 0.05,
  },
  performanceSummary: {
    twrNominal: { p10: 0.04, p25: 0.05, p50: 0.06, p75: 0.07, p90: 0.08 },
    twrReal: { p10: 0.02, p25: 0.03, p50: 0.04, p75: 0.05, p90: 0.06 },
    endBalanceNominal: { p10: 50, p25: 100, p50: 160, p75: 220, p90: 300 },
    endBalanceReal: { p10: 40, p25: 80, p50: 130, p75: 180, p90: 260 },
    meanReturnNominal: { p10: 0.04, p25: 0.05, p50: 0.06, p75: 0.07, p90: 0.08 },
    annualizedVolatility: { p10: 0.08, p25: 0.09, p50: 0.1, p75: 0.11, p90: 0.12 },
    maxDrawdown: { p10: -0.5, p25: -0.4, p50: -0.3, p75: -0.2, p90: -0.1 },
    maxDrawdownExcludingCashflows: { p10: -0.3, p25: -0.25, p50: -0.2, p75: -0.15, p90: -0.1 },
    safeWithdrawalRate: { p10: 0.03, p25: 0.04, p50: 0.05, p75: 0.06, p90: 0.07 },
    perpetualWithdrawalRate: { p10: 0.01, p25: 0.02, p50: 0.03, p75: 0.04, p90: 0.05 },
  },
  successRate: 0.72,
  inputsSnapshot: {},
  realValues: false,
  ranAt: '2026-05-01T00:00:00Z',
});

function make404(): AxiosError {
  return new AxiosError(
    'Not found',
    'ERR_BAD_REQUEST',
    undefined,
    null,
    {
      status: 404,
      statusText: 'Not Found',
      data: { message: 'Scenario not found' },
      headers: {},
      config: { headers: new AxiosHeaders() },
    },
  );
}

async function renderView(ids: string[]) {
  const { CompareScenariosView } = await import('./CompareScenariosView');
  let utils: ReturnType<typeof render>;
  await act(async () => {
    utils = render(<CompareScenariosView ids={ids} />);
  });
  return utils!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCache.getCachedResult.mockReturnValue(null);
  mockApi.get.mockImplementation(async (id: string) => scenario({ id, name: `Plan ${id}` }));
  mockApi.runSaved.mockImplementation(async () => result());
  mockRouter.push.mockReset();
  mockRouter.replace.mockReset();
  mockExportToCsv.mockReset();
});

// ─── Tests ────────────────────────────────────────────────────────────

describe('CompareScenariosView', () => {
  it('renders an empty state when no ids are provided', async () => {
    await renderView([]);
    expect(screen.getByText('No scenarios selected')).toBeInTheDocument();
  });

  it('asks for more when only one id is provided', async () => {
    await renderView(['only']);
    expect(screen.getByText('Need at least 2 scenarios')).toBeInTheDocument();
  });

  it('runs each scenario in parallel and renders columns', async () => {
    await renderView(['a', 'b']);

    await waitFor(() => {
      expect(mockApi.runSaved).toHaveBeenCalledWith('a');
      expect(mockApi.runSaved).toHaveBeenCalledWith('b');
    });
    await waitFor(() => {
      // Each scenario name appears once in the column header and once in the
      // Identity > Name metric row, so we use getAllByText.
      expect(screen.getAllByText('Plan a').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Plan b').length).toBeGreaterThan(0);
    });
    expect(mockCache.setCachedResult).toHaveBeenCalledWith('a', expect.any(Object));
  });

  it('hydrates from the result cache and skips auto-run when cached', async () => {
    mockCache.getCachedResult.mockImplementation((id: string) =>
      id === 'a' ? result() : null,
    );

    await renderView(['a', 'b']);

    await waitFor(() => {
      expect(screen.getByText('cached')).toBeInTheDocument();
    });
    // 'a' was cached so it should NOT auto-run; 'b' should.
    await waitFor(() => {
      expect(mockApi.runSaved).toHaveBeenCalledWith('b');
    });
    expect(mockApi.runSaved).not.toHaveBeenCalledWith('a');
  });

  it('keeps successful columns when one scenario errors', async () => {
    mockApi.runSaved.mockImplementation(async (id: string) => {
      if (id === 'b') throw new Error('Run failed');
      return result();
    });

    await renderView(['a', 'b']);
    await act(async () => {});

    await waitFor(() => {
      // Plan A column renders metric values, Plan B shows the failure message.
      expect(screen.getAllByText('Run failed').length).toBeGreaterThan(0);
    });
    // Both columns are still rendered (header titles).
    expect(screen.getAllByText('Plan a').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Plan b').length).toBeGreaterThan(0);
    // Retry button shows on the failed column.
    expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0);
  });

  it('marks 404-deleted scenarios as missing', async () => {
    mockApi.get.mockImplementation(async (id: string) => {
      if (id === 'gone') throw make404();
      return scenario({ id, name: `Plan ${id}` });
    });

    await renderView(['a', 'gone']);

    await waitFor(() => {
      expect(
        screen.getAllByText('Scenario no longer exists').length,
      ).toBeGreaterThan(0);
    });
    // Did NOT attempt to run the missing scenario.
    expect(mockApi.runSaved).not.toHaveBeenCalledWith('gone');
  });

  it('shows a banner when more than 4 ids are passed', async () => {
    await renderView(['a', 'b', 'c', 'd', 'e']);

    expect(
      screen.getByText(/Showing the first 4 of 5 scenarios/),
    ).toBeInTheDocument();
    // Only 4 scenarios should be fetched.
    await waitFor(() => {
      expect(mockApi.runSaved).toHaveBeenCalledTimes(4);
    });
    expect(mockApi.runSaved).not.toHaveBeenCalledWith('e');
  });

  it('dedupes repeated ids', async () => {
    await renderView(['a', 'a', 'b']);

    await waitFor(() => {
      expect(mockApi.get).toHaveBeenCalledTimes(2);
    });
  });

  it('removes a column via router.replace when the X button is clicked', async () => {
    await renderView(['a', 'b', 'c']);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Remove Plan a from comparison' }),
      ).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Remove Plan a from comparison' }),
      );
    });
    expect(mockRouter.replace).toHaveBeenCalledWith(
      '/reports/monte-carlo-simulation/compare?ids=b,c',
    );
  });

  it('reruns a column when Re-run is clicked', async () => {
    mockCache.getCachedResult.mockImplementation(() => result());
    await renderView(['a', 'b']);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Re-run' }).length).toBe(2);
    });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Re-run' })[0]);
    });
    await waitFor(() => {
      expect(mockApi.runSaved).toHaveBeenCalledWith('a');
    });
  });

  it('retries a failed column without re-fetching scenario metadata', async () => {
    let calls = 0;
    mockApi.runSaved.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('Boom');
      return result();
    });

    await renderView(['a', 'b']);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0);
    });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]);
    });
    await waitFor(() => {
      // Retry triggers a second runSaved call.
      expect(mockApi.runSaved.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('shows the empty state CTA link', async () => {
    await renderView([]);
    expect(
      screen.getByRole('link', { name: 'Go to Monte Carlo Simulation' }),
    ).toBeInTheDocument();
  });

  it('shows a CTA when only one id is provided', async () => {
    await renderView(['only-one']);
    expect(
      screen.getByRole('link', { name: 'Pick more scenarios' }),
    ).toBeInTheDocument();
  });

  it('disables Download CSV until at least 2 scenarios have loaded', async () => {
    let releaseB: (r: SimulationResult) => void = () => undefined;
    mockApi.runSaved.mockImplementation(async (id: string) => {
      if (id === 'b') {
        return new Promise<SimulationResult>((resolve) => {
          releaseB = resolve;
        });
      }
      return result();
    });

    await renderView(['a', 'b']);

    await waitFor(() => {
      expect(mockApi.runSaved).toHaveBeenCalledWith('a');
    });
    expect(
      screen.getByRole('button', { name: 'Download CSV' }),
    ).toBeDisabled();

    await act(async () => {
      releaseB(result());
    });

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Download CSV' }),
      ).not.toBeDisabled();
    });
  });

  it('downloads a CSV with one column per scenario when clicked', async () => {
    await renderView(['a', 'b']);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Download CSV' }),
      ).not.toBeDisabled();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    });

    expect(mockExportToCsv).toHaveBeenCalledTimes(1);
    const [filename, headers, rows] = mockExportToCsv.mock.calls[0];
    expect(filename).toBe('monte-carlo-comparison');
    expect(headers).toEqual(['Group', 'Metric', 'Plan a', 'Plan b']);
    // Every row carries [group, metric, valueA, valueB].
    for (const row of rows) {
      expect(row.length).toBe(4);
    }
    // Spot-check a known row: Final distribution > Median, currency-formatted.
    const median = (rows as string[][]).find(
      (r) => r[0] === 'Final distribution' && r[1] === 'Median',
    );
    expect(median).toBeDefined();
    expect(median![2]).toBe('$160');
  });

  it('handles non-404 fetch errors with an error column', async () => {
    mockApi.get.mockImplementation(async (id: string) => {
      if (id === 'b') throw new Error('Boom');
      return scenario({ id, name: `Plan ${id}` });
    });

    await renderView(['a', 'b']);
    await act(async () => {});

    await waitFor(() => {
      expect(screen.getAllByText('Boom').length).toBeGreaterThan(0);
    });
  });
});
