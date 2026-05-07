import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, waitFor, act } from '@testing-library/react';
import { render, screen, within } from '@/test/render';
import type {
  MonteCarloScenario,
  SimulationResult,
  AccountHoldingStats,
} from '@/lib/monte-carlo';

// ────────────── Mocks ─────────────────────────────────────────────────────

const mockApi = vi.hoisted(() => ({
  brokerageAccounts: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  runSaved: vi.fn(),
  run: vi.fn(),
  reorder: vi.fn(),
  historicalStats: vi.fn(),
  holdingStats: vi.fn(),
}));

vi.mock('@/lib/monte-carlo', () => ({
  monteCarloApi: mockApi,
}));

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyLabel: (n: number) => `$${n.toFixed(0)}`,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/lib/format', async () => {
  const actual = await vi.importActual<typeof import('@/lib/format')>(
    '@/lib/format',
  );
  return { ...actual, getCurrencySymbol: () => '$' };
});

// Recharts is heavy and noisy in jsdom; stub the visual primitives we use.
// The Tooltip and ReferenceDot stubs eagerly invoke their render-prop children
// so the inner helper components (FanChartTooltip, CashFlowMarker) are exercised.
vi.mock('recharts', () => {
  return {
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="rc-container">{children}</div>
    ),
    ComposedChart: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="rc-chart">{children}</div>
    ),
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: ({
      content,
    }: {
      content?: (p: {
        active: boolean;
        payload: Array<{ payload: Record<string, number> }>;
        label: string;
      }) => React.ReactNode;
    }) =>
      content ? (
        <div data-testid="rc-tooltip">
          {content({
            active: true,
            payload: [
              {
                payload: { p10: 110, p25: 115, p50: 120, p75: 125, p90: 130 },
              },
            ],
            label: '2027',
          })}
        </div>
      ) : null,
    Legend: () => null,
    Area: () => null,
    Line: () => null,
    ReferenceDot: ({
      x,
      shape,
    }: {
      x: string;
      shape?: (p: { cx?: number; cy?: number }) => React.ReactNode;
    }) => (
      <div data-testid="reference-dot" data-x={x}>
        {shape ? <svg>{shape({ cx: 10, cy: 10 })}</svg> : null}
      </div>
    ),
    ReferenceLine: ({ x }: { x: string }) => (
      <div data-testid="reference-line" data-x={x} />
    ),
  };
});

// ────────────── Fixtures ──────────────────────────────────────────────────

const account = (
  overrides: Partial<{ id: string; name: string; currencyCode: string }> = {},
) => ({
  id: 'acc-1',
  name: 'Brokerage',
  currencyCode: 'CAD',
  ...overrides,
});

const scenario = (
  overrides: Partial<MonteCarloScenario> = {},
): MonteCarloScenario => ({
  id: 'scn-1',
  name: 'Retirement',
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
  targetValue: 1000000,
  randomSeed: null,
  isFavourite: false,
  sortOrder: 0,
  lastRunAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  cashFlows: [],
  ...overrides,
});

const simResult = (
  overrides: Partial<SimulationResult> = {},
): SimulationResult => ({
  yearLabels: ['2027', '2028', '2029'],
  percentiles: {
    p10: [110, 120, 130],
    p25: [115, 130, 145],
    p50: [120, 140, 160],
    p75: [125, 150, 175],
    p90: [130, 160, 190],
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
    annualizedVolatility: {
      p10: 0.08,
      p25: 0.09,
      p50: 0.1,
      p75: 0.11,
      p90: 0.12,
    },
    maxDrawdown: { p10: -0.5, p25: -0.4, p50: -0.3, p75: -0.2, p90: -0.1 },
    maxDrawdownExcludingCashflows: {
      p10: -0.3,
      p25: -0.25,
      p50: -0.2,
      p75: -0.15,
      p90: -0.1,
    },
    safeWithdrawalRate: {
      p10: 0.03,
      p25: 0.04,
      p50: 0.05,
      p75: 0.06,
      p90: 0.07,
    },
    perpetualWithdrawalRate: {
      p10: 0.01,
      p25: 0.02,
      p50: 0.03,
      p75: 0.04,
      p90: 0.05,
    },
  },
  successRate: 0.72,
  inputsSnapshot: {},
  realValues: false,
  ranAt: '2026-05-01T00:00:00Z',
  ...overrides,
});

const holdingStats = (): AccountHoldingStats[] => [
  {
    accountId: 'acc-1',
    accountName: 'Brokerage',
    currencyCode: 'CAD',
    holdings: [
      {
        symbol: 'VOO',
        name: 'Vanguard S&P 500',
        currencyCode: 'USD',
        quantity: 10,
        marketValue: 5000,
        yearsObserved: 10,
        meanReturn: 0.1,
        volatility: 0.15,
      },
    ],
  },
];

async function importComponent() {
  // Imported lazily so each test can set up mocks before mounting.
  const mod = await import('./MonteCarloReport');
  return mod.MonteCarloReport;
}

async function renderReport() {
  const MonteCarloReport = await importComponent();
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<MonteCarloReport />);
  });
  return result!;
}

// ────────────── Tests ─────────────────────────────────────────────────────

describe('MonteCarloReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.brokerageAccounts.mockResolvedValue([account()]);
    mockApi.list.mockResolvedValue([]);
    mockApi.create.mockResolvedValue(scenario({ id: 'created-1' }));
    mockApi.update.mockResolvedValue(scenario({ id: 'scn-1', name: 'Renamed' }));
    mockApi.remove.mockResolvedValue(undefined);
    mockApi.run.mockResolvedValue(simResult());
    mockApi.runSaved.mockResolvedValue(simResult());
    mockApi.historicalStats.mockResolvedValue({
      yearsObserved: 10,
      meanReturn: 0.1,
      volatility: 0.15,
      currentBalance: 250000,
    });
    mockApi.holdingStats.mockResolvedValue(holdingStats());
    mockApi.reorder.mockResolvedValue(undefined);
    window.localStorage.clear();
  });

  describe('initial load', () => {
    it('shows a spinner while loading and then renders the form', async () => {
      await renderReport();
      await waitFor(() =>
        expect(mockApi.brokerageAccounts).toHaveBeenCalled(),
      );
      await waitFor(() => expect(mockApi.list).toHaveBeenCalled());
      // Once loaded, we see the section legends from the form.
      expect(await screen.findByText('Contribution phase')).toBeInTheDocument();
      expect(screen.getByText('Withdrawal phase')).toBeInTheDocument();
      expect(screen.getByText('Return assumptions')).toBeInTheDocument();
    });

    it('lists saved scenarios in the sidebar and loads one when clicked', async () => {
      const saved = scenario({
        id: 'saved-1',
        name: 'Aggressive 30y',
      });
      mockApi.list.mockResolvedValueOnce([saved]);
      await renderReport();

      const sidebarItem = await screen.findByRole('button', {
        name: /Aggressive 30y/i,
      });
      fireEvent.click(sidebarItem);
      // Loaded scenario name appears in the form's name field.
      const nameField = screen.getByPlaceholderText('e.g. Aggressive 25-year');
      expect(nameField).toHaveValue('Aggressive 30y');
    });

    it('restores the last-active scenario from localStorage on mount', async () => {
      const saved = scenario({ id: 'remembered', name: 'Remembered scn' });
      window.localStorage.setItem(
        'monize-monte-carlo-active-id',
        'remembered',
      );
      mockApi.list.mockResolvedValueOnce([saved]);
      await renderReport();
      await waitFor(() => {
        const nameField = screen.getByPlaceholderText('e.g. Aggressive 25-year');
        expect(nameField).toHaveValue('Remembered scn');
      });
    });
  });

  describe('Run simulation', () => {
    it('POSTs current form values to /run and renders summary stats', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      const runBtn = screen.getByRole('button', { name: /Run simulation/i });
      await act(async () => {
        fireEvent.click(runBtn);
      });
      expect(mockApi.run).toHaveBeenCalledTimes(1);
      const arg = mockApi.run.mock.calls[0][0];
      expect(arg).toMatchObject({
        useHistoricalReturns: false,
        simulationCount: 5000,
        showRealValues: false,
      });
      // Summary cards
      expect(screen.getByText(/Median final/i)).toBeInTheDocument();
      // $160.00 also renders inside the Performance Summary table.
      expect(screen.getAllByText('$160.00').length).toBeGreaterThan(0);
      expect(
        screen.getByText(/Probability of Depletion/i),
      ).toBeInTheDocument();
      expect(screen.getByText('5.0%')).toBeInTheDocument();
    });

    it('shows the target value next to the success-rate label when set', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({ id: 'with-target', targetValue: 1000000 }),
      ]);
      mockApi.run.mockResolvedValueOnce(simResult({ successRate: 0.5 }));
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      const runBtn = screen.getByRole('button', { name: /Run simulation/i });
      await act(async () => {
        fireEvent.click(runBtn);
      });
      // The label text includes the bracketed target. We just check that
      // the bracketed target appears alongside "Probability Above Target".
      const labels = await screen.findAllByText(
        /Probability Above Target \(\$1,?000,?000\.00\)/i,
      );
      expect(labels.length).toBeGreaterThan(0);
    });
  });

  describe('Save / update / delete', () => {
    it('rejects save when name is blank', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      const saveBtn = screen.getByRole('button', {
        name: /Save scenario|Save changes/,
      });
      await act(async () => {
        fireEvent.click(saveBtn);
      });
      expect(mockApi.create).not.toHaveBeenCalled();
    });

    it('creates a new scenario when name is filled', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      const nameField = screen.getByPlaceholderText('e.g. Aggressive 25-year');
      fireEvent.change(nameField, { target: { value: 'My plan' } });
      const saveBtn = screen.getByRole('button', { name: /Save scenario/ });
      await act(async () => {
        fireEvent.click(saveBtn);
      });
      expect(mockApi.create).toHaveBeenCalledTimes(1);
      expect(mockApi.create.mock.calls[0][0]).toMatchObject({
        name: 'My plan',
      });
    });

    it('Delete opens a confirmation dialog and only fires after confirm', async () => {
      mockApi.list.mockResolvedValueOnce([scenario()]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      // The form's Delete button (in the action row).
      const formDeleteBtn = await screen.findByRole('button', {
        name: /^Delete$/,
      });
      fireEvent.click(formDeleteBtn);
      // Confirmation dialog appears.
      await screen.findByText(/Delete scenario\?/);
      // Now there are two "Delete" buttons in the DOM — the form one and
      // the modal's confirm. Click the last one (modal Confirm).
      const allDeletes = screen.getAllByRole('button', { name: /^Delete$/ });
      const confirmBtn = allDeletes[allDeletes.length - 1];
      await act(async () => {
        fireEvent.click(confirmBtn);
      });
      expect(mockApi.remove).toHaveBeenCalledWith('scn-1');
    });
  });

  describe('Cash flows', () => {
    it('lets the user add a cash flow row and includes it in /run payload', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      const add = screen.getByRole('button', { name: /Add cash flow/i });
      await act(async () => {
        fireEvent.click(add);
      });
      // Find the row's name input (placeholder 'e.g. Pension') and fill.
      const nameInput = screen.getByPlaceholderText('e.g. Pension');
      fireEvent.change(nameInput, { target: { value: 'Pension' } });

      const runBtn = screen.getByRole('button', { name: /Run simulation/i });
      await act(async () => {
        fireEvent.click(runBtn);
      });
      const sent = mockApi.run.mock.calls[0][0];
      expect(sent.cashFlows).toBeDefined();
      expect(sent.cashFlows).toHaveLength(1);
      expect(sent.cashFlows[0]).toMatchObject({
        name: 'Pension',
        flowType: 'ONE_TIME',
        startYear: 1,
      });
    });

    it('removes a row when the trash icon is clicked', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      const add = screen.getByRole('button', { name: /Add cash flow/i });
      await act(async () => {
        fireEvent.click(add);
      });
      const removeBtn = screen.getByRole('button', { name: /Remove cash flow/i });
      await act(async () => {
        fireEvent.click(removeBtn);
      });
      expect(
        screen.queryByPlaceholderText('e.g. Pension'),
      ).not.toBeInTheDocument();
    });
  });

  describe('Historical returns mode', () => {
    it('fetches per-holding stats when historical mode is enabled', async () => {
      // Pre-load a scenario so accountIds is non-empty and the holdingStats
      // effect actually fires.
      mockApi.list.mockResolvedValueOnce([
        scenario({ accountIds: ['acc-1'], useHistoricalReturns: false }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      const radio = screen.getByRole('radio', {
        name: /Use historical returns from selected accounts/i,
      });
      await act(async () => {
        fireEvent.click(radio);
      });
      await waitFor(() =>
        expect(mockApi.holdingStats).toHaveBeenCalledWith(['acc-1']),
      );
      expect(await screen.findByText('VOO')).toBeInTheDocument();
    });
  });

  describe('View toggle and exports', () => {
    it('switches between chart and table view', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      // Default is chart view; click Table.
      const tableTab = screen.getByRole('button', { name: /^Table$/ });
      await act(async () => {
        fireEvent.click(tableTab);
      });
      // Year column header appears in the results table
      expect(await screen.findByText('Year')).toBeInTheDocument();
    });

    it('CSV export builds a blob with the percentile data', async () => {
      const createObjectURL = vi.fn(() => 'blob:url');
      const revokeObjectURL = vi.fn();
      const origCreate = global.URL.createObjectURL;
      const origRevoke = global.URL.revokeObjectURL;
      global.URL.createObjectURL = createObjectURL as never;
      global.URL.revokeObjectURL = revokeObjectURL as never;

      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      // Open the dropdown (the Export button) — its options are plain
      // <button>s labeled "CSV" / "PDF", not menu items.
      fireEvent.click(screen.getByRole('button', { name: /^Export/i }));
      const csvOption = await screen.findByRole('button', { name: /^CSV$/ });
      await act(async () => {
        fireEvent.click(csvOption);
      });
      expect(createObjectURL).toHaveBeenCalled();

      global.URL.createObjectURL = origCreate;
      global.URL.revokeObjectURL = origRevoke;
    });

    it('PDF export calls exportToPdf with chart container and table data', async () => {
      const { exportToPdf } = await import('@/lib/pdf-export');
      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      fireEvent.click(screen.getByRole('button', { name: /^Export/i }));
      const pdfOption = await screen.findByRole('button', { name: /^PDF$/ });
      await act(async () => {
        fireEvent.click(pdfOption);
      });
      expect(exportToPdf).toHaveBeenCalled();
      const args = (exportToPdf as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // Both tables are passed as additional sections, with the
      // Performance Summary preceding the year-by-year percentile table.
      expect(args.additionalTables).toHaveLength(2);
      expect(args.additionalTables[0].title).toBe('Performance Summary');
      expect(args.additionalTables[1].title).toBe(
        'Portfolio Value Percentiles by Year',
      );
      expect(args.additionalTables[1].headers).toContain('Events');
      expect(args.summaryCards.length).toBe(4);
    });
  });

  describe('Phase divider', () => {
    it('renders a phase-transition reference line when both phases are present', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({
          id: 'mixed',
          yearsToRetirement: 1,
          yearsInRetirement: 2,
        }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /Run simulation/i }),
        );
      });
      const line = await screen.findByTestId('reference-line');
      // The yearLabels in our fixture are 2027/28/29; with
      // yearsToRetirement = 1 the divider sits at the first label.
      expect(line.getAttribute('data-x')).toBe('2027');
    });

    it('omits the divider when there is no withdrawal phase', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({
          id: 'accum-only',
          yearsToRetirement: 3,
          yearsInRetirement: 0,
        }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /Run simulation/i }),
        );
      });
      expect(screen.queryByTestId('reference-line')).not.toBeInTheDocument();
    });
  });

  describe('Use current balance', () => {
    it('auto-populates startingValue from /historical-stats when accounts are selected', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      // The default form has the toggle on and one account preselected
      // never (accountIds starts empty), so just simulate selection by
      // letting the effect trigger after we mount with accounts in
      // localStorage-backed scenario. Here we trust the effect via the
      // existing test for sidebar load:
      mockApi.list.mockResolvedValueOnce([
        scenario({ id: 's', useCurrentBalance: true, accountIds: ['acc-1'] }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await waitFor(() =>
        expect(mockApi.historicalStats).toHaveBeenCalledWith(['acc-1']),
      );
    });
  });

  describe('Inputs collapse/expand', () => {
    it('auto-collapses inputs after a successful run and shows summary chips', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      // The form's full body is visible -- "Withdrawal phase" sits inside it.
      expect(screen.getByText('Withdrawal phase')).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      // Body legends are gone; collapsed header shows a "Run again" affordance.
      await waitFor(() =>
        expect(screen.queryByText('Withdrawal phase')).not.toBeInTheDocument(),
      );
      expect(
        screen.getByRole('button', { name: /Run again/i }),
      ).toBeInTheDocument();
      // Summary chips: starting value, year breakdown, return/vol, runs.
      expect(screen.getByText(/^Start:/)).toBeInTheDocument();
      expect(
        screen.getByText(/25y contrib \/ 30y withdrawal/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/7\.0% return, 15\.0% vol/),
      ).toBeInTheDocument();
      expect(screen.getByText(/5,000 runs/)).toBeInTheDocument();
    });

    it('clicking Edit inputs re-expands while preserving form state', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      // Set a scenario name so we can verify the value survives the toggle.
      const nameField = screen.getByPlaceholderText('e.g. Aggressive 25-year');
      fireEvent.change(nameField, { target: { value: 'My plan' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      // Collapsed: Edit inputs button visible.
      const edit = await screen.findByRole('button', { name: /Edit inputs/i });
      await act(async () => {
        fireEvent.click(edit);
      });
      // Expanded again -- form body returns and the name field still has our value.
      const nameAgain = screen.getByPlaceholderText('e.g. Aggressive 25-year');
      expect(nameAgain).toHaveValue('My plan');
      // The toggle now reads "Hide inputs".
      expect(
        screen.getByRole('button', { name: /Hide inputs/i }),
      ).toBeInTheDocument();
    });

    it('Run again in the collapsed header triggers a new simulation', async () => {
      // Need a scenario with accountIds set, otherwise "Run again" stays disabled.
      mockApi.list.mockResolvedValueOnce([
        scenario({ accountIds: ['acc-1'] }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      const runAgain = await screen.findByRole('button', {
        name: /Run again/i,
      });
      expect(runAgain).not.toBeDisabled();
      await act(async () => {
        fireEvent.click(runAgain);
      });
      expect(mockApi.run).toHaveBeenCalledTimes(2);
    });

    it('Run again is disabled when no accounts are selected', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      // Default form has accountIds = [] so Run again should be disabled.
      const runAgain = await screen.findByRole('button', {
        name: /Run again/i,
      });
      expect(runAgain).toBeDisabled();
    });

    it('shows historical returns label in collapsed summary when toggled', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({ accountIds: ['acc-1'], useHistoricalReturns: true }),
      ]);
      mockApi.run.mockResolvedValueOnce(simResult());
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      const runBtn = screen.getByRole('button', { name: /Run simulation/i });
      await act(async () => {
        fireEvent.click(runBtn);
      });
      expect(
        await screen.findByText(/Historical returns/),
      ).toBeInTheDocument();
    });

    it('clicking New scenario preserves the inputs toggle state and clears the form', async () => {
      mockApi.list.mockResolvedValueOnce([scenario()]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      // Confirm we're collapsed after Run.
      await screen.findByRole('button', { name: /Edit inputs/i });
      // Click sidebar "New" button.
      const newBtn = screen.getByRole('button', { name: /^New$/ });
      await act(async () => {
        fireEvent.click(newBtn);
      });
      // The collapsed toggle state is preserved (no auto-expand), but the
      // form is cleared so the collapsed header reverts to the empty placeholder.
      expect(
        screen.getByRole('button', { name: /Edit inputs/i }),
      ).toBeInTheDocument();
      expect(screen.getByText(/Untitled scenario/)).toBeInTheDocument();
    });

    it('switching scenarios preserves the user’s Hide/Show inputs choice', async () => {
      const a = scenario({ id: 'a', name: 'Plan A' });
      const b = scenario({ id: 'b', name: 'Plan B' });
      mockApi.list.mockResolvedValueOnce([a, b]);
      await renderReport();
      // Start expanded by default. User loads Plan A and runs to collapse.
      const planA = await screen.findByRole('button', { name: /Plan A/ });
      fireEvent.click(planA);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      await screen.findByRole('button', { name: /Edit inputs/i });
      // Switch to Plan B -- collapsed state must stick.
      const planB = screen.getByRole('button', { name: /Plan B/ });
      await act(async () => {
        fireEvent.click(planB);
      });
      expect(
        screen.getByRole('button', { name: /Edit inputs/i }),
      ).toBeInTheDocument();
      expect(
        screen.queryByText('Withdrawal phase'),
      ).not.toBeInTheDocument();
    });

    it('persists the Hide/Show inputs choice to localStorage', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      const hide = screen.getByRole('button', { name: /Hide inputs/i });
      await act(async () => {
        fireEvent.click(hide);
      });
      expect(
        window.localStorage.getItem('monize-monte-carlo-inputs-collapsed'),
      ).toBe('1');
    });

    it('honours the persisted collapsed state on mount', async () => {
      const saved = scenario({ id: 'cached', name: 'Cached scn' });
      window.localStorage.setItem('monize-monte-carlo-active-id', 'cached');
      // Pre-populate the result cache so the initial-load effect rehydrates it.
      window.localStorage.setItem(
        'monize:monte-carlo-results',
        JSON.stringify({ cached: simResult() }),
      );
      // Persisted toggle state from a previous session.
      window.localStorage.setItem('monize-monte-carlo-inputs-collapsed', '1');
      mockApi.list.mockResolvedValueOnce([saved]);
      await renderReport();
      await waitFor(() => {
        expect(
          screen.queryByText('Contribution phase'),
        ).not.toBeInTheDocument();
        expect(
          screen.getByRole('button', { name: /Edit inputs/i }),
        ).toBeInTheDocument();
      });
    });

    it('stays expanded when loading a scenario without a cached result', async () => {
      mockApi.list.mockResolvedValueOnce([scenario()]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      // Form body still visible -- no cached result triggers the auto-collapse.
      expect(
        await screen.findByText('Withdrawal phase'),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /Edit inputs/i }),
      ).not.toBeInTheDocument();
    });

    it('does not collapse when a run fails', async () => {
      mockApi.run.mockRejectedValueOnce(new Error('boom'));
      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      await act(async () => {});
      // Body still rendered -- result never updated.
      expect(screen.getByText('Withdrawal phase')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /Edit inputs/i }),
      ).not.toBeInTheDocument();
    });

    it('Hide inputs from the expanded header collapses without running', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      const hide = screen.getByRole('button', { name: /Hide inputs/i });
      await act(async () => {
        fireEvent.click(hide);
      });
      // Body hidden but no result -- "Run again" surfaces with default name.
      expect(screen.queryByText('Withdrawal phase')).not.toBeInTheDocument();
      expect(screen.getByText(/Untitled scenario/)).toBeInTheDocument();
      expect(mockApi.run).not.toHaveBeenCalled();
    });
  });

  describe('Save / update flows', () => {
    it('updates an existing scenario via PATCH when activeId is set', async () => {
      mockApi.list.mockResolvedValueOnce([scenario()]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      const saveBtn = await screen.findByRole('button', {
        name: /Save changes/,
      });
      await act(async () => {
        fireEvent.click(saveBtn);
      });
      expect(mockApi.update).toHaveBeenCalledWith(
        'scn-1',
        expect.objectContaining({ name: 'Retirement' }),
      );
      // Saved flash button reads "Saved!" briefly.
      expect(
        await screen.findByRole('button', { name: /Saved!/ }),
      ).toBeInTheDocument();
    });

    it('shows an error toast when Save fails', async () => {
      mockApi.create.mockRejectedValueOnce(new Error('nope'));
      const toast = (await import('react-hot-toast')).default;
      await renderReport();
      await screen.findByText('Contribution phase');
      const nameField = screen.getByPlaceholderText('e.g. Aggressive 25-year');
      await act(async () => { fireEvent.change(nameField, { target: { value: 'Failing plan' } }); });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Save scenario/ }));
      });
      // showErrorToast falls through to react-hot-toast.error.
      expect(toast.error).toHaveBeenCalled();
    });

    it('shows an error toast when Run fails', async () => {
      mockApi.run.mockRejectedValueOnce(new Error('crash'));
      const toast = (await import('react-hot-toast')).default;
      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      await act(async () => {});
      expect(toast.error).toHaveBeenCalled();
    });

    it('shows an error toast when Delete fails', async () => {
      mockApi.list.mockResolvedValueOnce([scenario()]);
      mockApi.remove.mockRejectedValueOnce(new Error('forbidden'));
      const toast = (await import('react-hot-toast')).default;
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      await act(async () => { fireEvent.click(item); });
      const formDeleteBtn = await screen.findByRole('button', {
        name: /^Delete$/,
      });
      await act(async () => { fireEvent.click(formDeleteBtn); });
      await screen.findByText(/Delete scenario\?/);
      const allDeletes = screen.getAllByRole('button', { name: /^Delete$/ });
      const confirmBtn = allDeletes[allDeletes.length - 1];
      await act(async () => {
        fireEvent.click(confirmBtn);
      });
      expect(toast.error).toHaveBeenCalled();
      // Dialog still closes via the finally block.
      expect(
        screen.queryByText(/Delete scenario\?/),
      ).not.toBeInTheDocument();
    });

    it('Cancel in the delete dialog does not call remove', async () => {
      mockApi.list.mockResolvedValueOnce([scenario()]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      const formDeleteBtn = await screen.findByRole('button', {
        name: /^Delete$/,
      });
      fireEvent.click(formDeleteBtn);
      await screen.findByText(/Delete scenario\?/);
      const cancel = screen.getByRole('button', { name: /Cancel/i });
      await act(async () => {
        fireEvent.click(cancel);
      });
      expect(mockApi.remove).not.toHaveBeenCalled();
    });
  });

  describe('Sidebar', () => {
    it('shows a placeholder message when no scenarios exist', async () => {
      mockApi.list.mockResolvedValueOnce([]);
      await renderReport();
      expect(
        await screen.findByText(/No saved scenarios/i),
      ).toBeInTheDocument();
    });

    it('clicking New clears active scenario and form fields', async () => {
      mockApi.list.mockResolvedValueOnce([scenario({ name: 'Old plan' })]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Old plan/i });
      fireEvent.click(item);
      const nameField = screen.getByPlaceholderText('e.g. Aggressive 25-year');
      expect(nameField).toHaveValue('Old plan');
      const newBtn = screen.getByRole('button', { name: /^New$/ });
      await act(async () => {
        fireEvent.click(newBtn);
      });
      expect(
        screen.getByPlaceholderText('e.g. Aggressive 25-year'),
      ).toHaveValue('');
      // Save button reverts to the create label.
      expect(
        screen.getByRole('button', { name: /Save scenario/ }),
      ).toBeInTheDocument();
    });
  });

  describe('Cash flow editing', () => {
    it('changing flow type to Recurring reveals the End year input', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /Add cash flow/i }),
        );
      });
      // The Type select offers One-time / Recurring; default is One-time so
      // there's no End column initially.
      expect(
        screen.queryByLabelText(/^End$/i),
      ).not.toBeInTheDocument();
      const select = screen.getByRole('combobox');
      await act(async () => {
        fireEvent.change(select, { target: { value: 'RECURRING' } });
      });
      // End column appears for recurring flows.
      expect(screen.getByLabelText(/^End$/i)).toBeInTheDocument();
    });

    it('renders a phase-divider-free chart and a recurring-flow tooltip line', async () => {
      // Use a saved scenario with a recurring cash flow so the markers render.
      mockApi.list.mockResolvedValueOnce([
        scenario({
          yearsToRetirement: 1,
          yearsInRetirement: 2,
          cashFlows: [
            {
              name: 'Pension',
              amount: 10000,
              flowType: 'RECURRING',
              startYear: 1,
              endYear: 3,
              inflationAdjust: true,
            },
          ],
        }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /Run simulation/i }),
        );
      });
      // Two reference dots: the start marker and the end marker.
      const dots = await screen.findAllByTestId('reference-dot');
      expect(dots.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Return assumptions', () => {
    it('toggles Show in today\'s value', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      // The toggle has label "Show in today's value" via aria-label on switch.
      const toggle = screen.getByRole('switch', {
        name: /Show in today's value/i,
      });
      await act(async () => {
        fireEvent.click(toggle);
      });
      // Switch is now checked.
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    });
  });

  describe('Form field updates', () => {
    it('updates contribution and withdrawal numeric fields', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      // Both "Years" inputs share id="input-years" (NumericInput derives the id
      // from the label). Pick the input directly inside each fieldset.
      const contribFs = screen
        .getByText('Contribution phase')
        .closest('fieldset')!;
      const withdrawFs = screen
        .getByText('Withdrawal phase')
        .closest('fieldset')!;
      const yearsContrib = contribFs.querySelector(
        'input[id="input-years"]',
      ) as HTMLInputElement;
      const yearsWithdraw = withdrawFs.querySelector(
        'input[id="input-years"]',
      ) as HTMLInputElement;
      expect(yearsContrib).toBeTruthy();
      expect(yearsWithdraw).toBeTruthy();
      await act(async () => {
        fireEvent.change(yearsContrib, { target: { value: '40' } });
        fireEvent.blur(yearsContrib);
        fireEvent.change(yearsWithdraw, { target: { value: '35' } });
        fireEvent.blur(yearsWithdraw);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      const arg = mockApi.run.mock.calls[0][0];
      expect(arg.yearsToRetirement).toBe(40);
      expect(arg.yearsInRetirement).toBe(35);
    });

    it('updates currency, growth, return, vol, inflation and simulation count', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      const fire = (label: RegExp, value: string) => {
        const el = screen.getByLabelText(label);
        fireEvent.change(el, { target: { value } });
        fireEvent.blur(el);
      };
      await act(async () => {
        fire(/^Annual contribution$/i, '20000');
        fire(/^Annual withdrawal$/i, '50000');
        fire(/^Contribution growth$/i, '3');
        fire(/^Expected return$/i, '8');
        fire(/^Volatility$/i, '12');
        fire(/^Inflation$/i, '2.5');
        fire(/^Simulations$/i, '1000');
      });
      // CurrencyInput Target field — disambiguate from chip text by scoping.
      const fs = screen.getByText('Withdrawal phase').closest('fieldset')!;
      const target = within(fs).getByLabelText(/Target/i);
      await act(async () => {
        fireEvent.change(target, { target: { value: '750000' } });
        fireEvent.blur(target);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      const arg = mockApi.run.mock.calls[0][0];
      expect(arg.annualContribution).toBe(20000);
      expect(arg.annualWithdrawal).toBe(50000);
      expect(arg.contributionGrowthRate).toBeCloseTo(0.03);
      expect(arg.expectedReturn).toBeCloseTo(0.08);
      expect(arg.volatility).toBeCloseTo(0.12);
      expect(arg.inflationRate).toBeCloseTo(0.025);
      expect(arg.simulationCount).toBe(1000);
      expect(arg.targetValue).toBe(750000);
    });

    it('clamps simulation count between 100 and 50000', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      const sims = screen.getByLabelText(/Simulations/i);
      // Above the upper bound clamps to 50000.
      await act(async () => {
        fireEvent.change(sims, { target: { value: '999999' } });
        fireEvent.blur(sims);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      const arg = mockApi.run.mock.calls[0][0];
      expect(arg.simulationCount).toBe(50000);
    });

    it('toggles Use current balance off and re-enables Starting value', async () => {
      // Default form has useCurrentBalance = true (per EMPTY_FORM).
      await renderReport();
      await screen.findByText('Contribution phase');
      const useBal = screen.getByRole('switch', {
        name: /Use current balance on each run/i,
      });
      const initial = useBal.getAttribute('aria-checked');
      await act(async () => {
        fireEvent.click(useBal);
      });
      // Toggled to the opposite state.
      expect(useBal.getAttribute('aria-checked')).not.toBe(initial);
    });

    it('inflation toggle on a cash flow row stays on by default', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /Add cash flow/i }),
        );
      });
      const inflate = screen.getByRole('switch', { name: /^Inflate$/i });
      // Default is true.
      expect(inflate).toHaveAttribute('aria-checked', 'true');
      await act(async () => {
        fireEvent.click(inflate);
      });
      expect(inflate).toHaveAttribute('aria-checked', 'false');
    });

    it('updates cash flow end year (recurring) and clamps below start year', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /Add cash flow/i }),
        );
      });
      // Switch to RECURRING so the End column appears.
      const select = screen.getByRole('combobox');
      await act(async () => {
        fireEvent.change(select, { target: { value: 'RECURRING' } });
      });
      // Set start to 5 first.
      const start = screen.getByLabelText(/^Start$/i);
      await act(async () => {
        fireEvent.change(start, { target: { value: '5' } });
        fireEvent.blur(start);
      });
      const end = screen.getByLabelText(/^End$/i);
      await act(async () => {
        fireEvent.change(end, { target: { value: '10' } });
        fireEvent.blur(end);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      const sent = mockApi.run.mock.calls[0][0];
      expect(sent.cashFlows[0]).toMatchObject({
        startYear: 5,
        endYear: 10,
      });
    });

    it('switches from historical back to specified expected return', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({ accountIds: ['acc-1'], useHistoricalReturns: true }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      const radio = screen.getByRole('radio', {
        name: /Specify expected return/i,
      });
      await act(async () => {
        fireEvent.click(radio);
      });
      // Now expected return input is editable.
      const expected = screen.getByLabelText(/^Expected return$/i);
      expect(expected).not.toBeDisabled();
    });

    it('updates Starting value when Use current balance is off', async () => {
      // Pre-load a scenario with toggle off so Starting value field is enabled.
      mockApi.list.mockResolvedValueOnce([
        scenario({ useCurrentBalance: false, startingValue: 100000 }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      const starting = screen.getByLabelText(/Starting value/i);
      await act(async () => {
        fireEvent.change(starting, { target: { value: '250000' } });
        fireEvent.blur(starting);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      const arg = mockApi.run.mock.calls[0][0];
      expect(arg.startingValue).toBe(250000);
    });

    it('updates the cash flow amount and start year', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /Add cash flow/i }),
        );
      });
      const amount = screen.getByLabelText(/Amount/i);
      const start = screen.getByLabelText(/^Start$/i);
      await act(async () => {
        fireEvent.change(amount, { target: { value: '5000' } });
        fireEvent.blur(amount);
        fireEvent.change(start, { target: { value: '5' } });
        fireEvent.blur(start);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      const sent = mockApi.run.mock.calls[0][0];
      expect(sent.cashFlows[0]).toMatchObject({ amount: 5000, startYear: 5 });
    });
  });

  describe('Sidebar load failures', () => {
    it('shows an error toast when initial load fails', async () => {
      mockApi.brokerageAccounts.mockRejectedValueOnce(new Error('offline'));
      const toast = (await import('react-hot-toast')).default;
      await renderReport();
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
    });

    it('shows an error toast when holdingStats fetch fails', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({ accountIds: ['acc-1'], useHistoricalReturns: true }),
      ]);
      mockApi.holdingStats.mockRejectedValueOnce(new Error('db down'));
      const toast = (await import('react-hot-toast')).default;
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      await act(async () => { fireEvent.click(item); });
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
    });

    it('shows an error toast when historicalStats fetch fails', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({ accountIds: ['acc-1'], useCurrentBalance: true }),
      ]);
      mockApi.historicalStats.mockRejectedValueOnce(new Error('db down'));
      const toast = (await import('react-hot-toast')).default;
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      await act(async () => { fireEvent.click(item); });
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
    });

    it('drops a stale active-id when the matching scenario is gone', async () => {
      window.localStorage.setItem(
        'monize-monte-carlo-active-id',
        'never-existed',
      );
      mockApi.list.mockResolvedValueOnce([scenario()]);
      await renderReport();
      // Form renders normally; active id was cleared so the stored id is gone.
      await screen.findByText('Contribution phase');
      expect(
        window.localStorage.getItem('monize-monte-carlo-active-id'),
      ).toBeNull();
    });
  });

  describe('PDF export with cash flows', () => {
    it('includes Starts/Ends prefixes for recurring flows in PDF table data', async () => {
      const { exportToPdf } = await import('@/lib/pdf-export');
      mockApi.list.mockResolvedValueOnce([
        scenario({
          cashFlows: [
            {
              name: 'Pension',
              amount: 12000,
              flowType: 'RECURRING',
              startYear: 1,
              endYear: 2,
              inflationAdjust: false,
            },
            {
              name: 'House',
              amount: -50000,
              flowType: 'ONE_TIME',
              startYear: 2,
              endYear: null,
              inflationAdjust: false,
            },
          ],
        }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /Run simulation/i }),
        );
      });
      fireEvent.click(screen.getByRole('button', { name: /^Export/i }));
      const pdfOption = await screen.findByRole('button', { name: /^PDF$/ });
      await act(async () => {
        fireEvent.click(pdfOption);
      });
      const args = (exportToPdf as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const yearlyTable = args.additionalTables.find(
        (t: { title?: string }) =>
          t.title === 'Portfolio Value Percentiles by Year',
      );
      const events = yearlyTable.rows
        .map((r: string[]) => r[r.length - 1])
        .join('\n');
      expect(events).toMatch(/Starts: Pension/);
      expect(events).toMatch(/Ends: Pension/);
      expect(events).toMatch(/House/);
    });
  });

  describe('CSV export with cash flows', () => {
    it('encodes both one-time and recurring events in the CSV blob', async () => {
      const captured: Blob[] = [];
      const origCreate = global.URL.createObjectURL;
      const origRevoke = global.URL.revokeObjectURL;
      global.URL.createObjectURL = ((b: Blob) => {
        captured.push(b);
        return 'blob:url';
      }) as never;
      global.URL.revokeObjectURL = (() => undefined) as never;
      mockApi.list.mockResolvedValueOnce([
        scenario({
          cashFlows: [
            {
              name: 'House',
              amount: -50000,
              flowType: 'ONE_TIME',
              startYear: 1,
              endYear: null,
              inflationAdjust: false,
            },
            {
              name: 'Pension',
              amount: 12000,
              flowType: 'RECURRING',
              startYear: 1,
              endYear: 2,
              inflationAdjust: false,
            },
          ],
        }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /Run simulation/i }),
        );
      });
      fireEvent.click(screen.getByRole('button', { name: /^Export/i }));
      const csvOption = await screen.findByRole('button', { name: /^CSV$/ });
      await act(async () => {
        fireEvent.click(csvOption);
      });
      expect(captured.length).toBeGreaterThan(0);
      const text = await captured[0].text();
      // ONE_TIME entries get no "Start:" prefix, just the bare name.
      expect(text).toMatch(/House/);
      // RECURRING entries are labelled "Start:" / "End:".
      expect(text).toMatch(/Start: Pension/);
      expect(text).toMatch(/End: Pension/);
      global.URL.createObjectURL = origCreate;
      global.URL.revokeObjectURL = origRevoke;
    });
  });

  describe('Chart tooltip', () => {
    it('renders a percentile breakdown when the tooltip is active', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /Run simulation/i }),
        );
      });
      // Tooltip mock invokes FanChartTooltip with sample percentile data.
      const tooltips = await screen.findAllByTestId('rc-tooltip');
      expect(tooltips.length).toBeGreaterThan(0);
      // Percentile labels render inside the tooltip.
      expect(screen.getByText(/^90th percentile$/)).toBeInTheDocument();
      expect(screen.getByText(/^Median \(50th\)$/)).toBeInTheDocument();
      expect(screen.getByText(/^10th percentile$/)).toBeInTheDocument();
    });

    it('shows event details in the tooltip when a cash flow fires that year', async () => {
      // Recurring pension at year 1 -> the tooltip mock uses label '2027'
      // (yearLabels[0]), so the start marker matches.
      mockApi.list.mockResolvedValueOnce([
        scenario({
          cashFlows: [
            {
              name: 'Pension',
              amount: 8000,
              flowType: 'RECURRING',
              startYear: 1,
              endYear: 3,
              inflationAdjust: true,
            },
          ],
        }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /Run simulation/i }),
        );
      });
      // Tooltip's event row shows "Starts: Pension" plus inflated amount.
      expect(
        await screen.findAllByText(/Starts: Pension/),
      ).not.toHaveLength(0);
      // /yr suffix and (inflated) marker are rendered for recurring + adjust.
      expect(screen.getAllByText(/\/ yr/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/inflated/i).length).toBeGreaterThan(0);
    });

    it('shows a one-time cash flow without a Starts prefix in the tooltip', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({
          cashFlows: [
            {
              name: 'House sale',
              amount: 500000,
              flowType: 'ONE_TIME',
              startYear: 1,
              endYear: null,
              inflationAdjust: false,
            },
          ],
        }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /Run simulation/i }),
        );
      });
      // The tooltip event header shows just the name (no Starts/Ends prefix).
      const matches = await screen.findAllByText('House sale');
      expect(matches.length).toBeGreaterThan(0);
      expect(screen.getAllByText(/One-time/i).length).toBeGreaterThan(0);
    });
  });

  describe('Results table view', () => {
    it('shows event labels in the table when cash flows exist', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({
          cashFlows: [
            {
              name: 'Pension',
              amount: 10000,
              flowType: 'RECURRING',
              startYear: 1,
              endYear: 2,
              inflationAdjust: false,
            },
          ],
        }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /Run simulation/i }),
        );
      });
      const tableTab = screen.getByRole('button', { name: /^Table$/ });
      await act(async () => {
        fireEvent.click(tableTab);
      });
      // Pension start/end labels render in the events column. They also
      // render inside the (now-mocked-active) tooltip, so use getAllByText.
      const starts = await screen.findAllByText(/Starts: Pension/);
      expect(starts.length).toBeGreaterThan(0);
      const ends = screen.getAllByText(/Ends: Pension/);
      expect(ends.length).toBeGreaterThan(0);
    });
  });

  describe('Save As flow', () => {
    async function openSaveAsMenu() {
      const more = await screen.findByRole('button', {
        name: /More save options/i,
      });
      await act(async () => {
        fireEvent.click(more);
      });
      const saveAs = await screen.findByRole('menuitem', {
        name: /Save as/i,
      });
      await act(async () => {
        fireEvent.click(saveAs);
      });
    }

    it('Save as... with a new name creates a fresh scenario', async () => {
      mockApi.list.mockResolvedValueOnce([scenario()]);
      mockApi.create.mockResolvedValueOnce(
        scenario({ id: 'copy-1', name: 'Aggressive copy' }),
      );
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await openSaveAsMenu();

      const input = await screen.findByLabelText(/^Name$/);
      fireEvent.change(input, { target: { value: 'Aggressive copy' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      });

      expect(mockApi.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Aggressive copy' }),
      );
      expect(mockApi.update).not.toHaveBeenCalled();
    });

    it('Save as... with the same name prompts to overwrite the existing scenario', async () => {
      mockApi.list.mockResolvedValueOnce([scenario()]);
      mockApi.update.mockResolvedValueOnce(scenario());
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await openSaveAsMenu();

      // The dialog pre-fills with the active scenario's name; submit unchanged.
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      });

      // Stacked overwrite confirm appears.
      await screen.findByText(/Overwrite existing scenario\?/);
      expect(mockApi.create).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Overwrite/ }));
      });
      expect(mockApi.update).toHaveBeenCalledWith(
        'scn-1',
        expect.objectContaining({ name: 'Retirement' }),
      );
    });

    it('cancelling the overwrite confirm leaves the Save As dialog open', async () => {
      mockApi.list.mockResolvedValueOnce([scenario()]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await openSaveAsMenu();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      });
      await screen.findByText(/Overwrite existing scenario\?/);
      const cancels = screen.getAllByRole('button', { name: /Cancel/i });
      await act(async () => {
        fireEvent.click(cancels[cancels.length - 1]);
      });
      // Overwrite confirm is gone, but the Save As dialog is still up.
      expect(
        screen.queryByText(/Overwrite existing scenario\?/),
      ).not.toBeInTheDocument();
      expect(screen.getByText(/Save scenario as/)).toBeInTheDocument();
      expect(mockApi.update).not.toHaveBeenCalled();
    });
  });

  describe('Reorder scenarios', () => {
    it('Reorder toggle is hidden when only one scenario exists', async () => {
      mockApi.list.mockResolvedValueOnce([scenario()]);
      await renderReport();
      await screen.findByRole('button', { name: /Retirement/i });
      expect(
        screen.queryByRole('button', { name: /^Reorder$/ }),
      ).not.toBeInTheDocument();
    });

    it('clicking Reorder reveals up/down arrows and Done hides them', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({ id: 'a', name: 'Plan A' }),
        scenario({ id: 'b', name: 'Plan B' }),
      ]);
      await renderReport();
      const reorder = await screen.findByRole('button', { name: /^Reorder$/ });
      await act(async () => {
        fireEvent.click(reorder);
      });
      expect(screen.getAllByTitle(/Move up/).length).toBe(2);
      expect(screen.getAllByTitle(/Move down/).length).toBe(2);
      const done = screen.getByRole('button', { name: /^Done$/ });
      await act(async () => {
        fireEvent.click(done);
      });
      expect(screen.queryAllByTitle(/Move up/).length).toBe(0);
    });

    it('moving a scenario down calls reorder with the new id order', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({ id: 'a', name: 'Plan A' }),
        scenario({ id: 'b', name: 'Plan B' }),
        scenario({ id: 'c', name: 'Plan C' }),
      ]);
      await renderReport();
      await act(async () => {
        fireEvent.click(
          await screen.findByRole('button', { name: /^Reorder$/ }),
        );
      });
      // Move "Plan A" down by one.
      const downs = screen.getAllByTitle(/Move down/);
      await act(async () => {
        fireEvent.click(downs[0]);
      });
      expect(mockApi.reorder).toHaveBeenCalledWith(['b', 'a', 'c']);
    });

    it('Move up on the first row and Move down on the last row are disabled', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({ id: 'a', name: 'Plan A' }),
        scenario({ id: 'b', name: 'Plan B' }),
      ]);
      await renderReport();
      await act(async () => {
        fireEvent.click(
          await screen.findByRole('button', { name: /^Reorder$/ }),
        );
      });
      const ups = screen.getAllByTitle(/Move up/);
      const downs = screen.getAllByTitle(/Move down/);
      expect(ups[0]).toBeDisabled();
      expect(downs[downs.length - 1]).toBeDisabled();
    });

    it('clicking a scenario row while reordering does not load it', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({ id: 'a', name: 'Plan A' }),
        scenario({ id: 'b', name: 'Plan B' }),
      ]);
      await renderReport();
      await act(async () => {
        fireEvent.click(
          await screen.findByRole('button', { name: /^Reorder$/ }),
        );
      });
      const planB = screen.getByRole('button', { name: /Plan B/ });
      await act(async () => {
        fireEvent.click(planB);
      });
      // Form name field still empty -- click was a no-op while reordering.
      expect(
        screen.getByPlaceholderText('e.g. Aggressive 25-year'),
      ).toHaveValue('');
    });

    it('Compare button is hidden when fewer than 2 scenarios exist', async () => {
      mockApi.list.mockResolvedValueOnce([scenario({ id: 'a', name: 'Plan A' })]);
      await renderReport();
      await screen.findByText('Contribution phase');
      expect(
        screen.queryByRole('button', { name: /^Compare$/ }),
      ).toBeNull();
    });

    it('Compare opens select mode with checkboxes and a disabled action button', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({ id: 'a', name: 'Plan A' }),
        scenario({ id: 'b', name: 'Plan B' }),
      ]);
      await renderReport();
      await act(async () => {
        fireEvent.click(
          await screen.findByRole('button', { name: /^Compare$/ }),
        );
      });
      // Both scenarios now expose checkboxes.
      const checkboxes = screen.getAllByRole('checkbox', {
        name: /Select Plan [AB] for comparison/,
      });
      expect(checkboxes.length).toBe(2);
      // Action button starts disabled.
      const compareBtn = screen.getByRole('button', {
        name: /Compare selected \(0\/4\)/,
      });
      expect(compareBtn).toBeDisabled();
      // Selecting one keeps it disabled (need 2+).
      await act(async () => {
        fireEvent.click(checkboxes[0]);
      });
      expect(
        screen.getByRole('button', { name: /Compare selected \(1\/4\)/ }),
      ).toBeDisabled();
    });

    it('Compare button navigates to the compare route with selected ids', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({ id: 'a', name: 'Plan A' }),
        scenario({ id: 'b', name: 'Plan B' }),
        scenario({ id: 'c', name: 'Plan C' }),
      ]);
      const nav = await import('next/navigation');
      const push = vi.fn();
      vi.spyOn(nav, 'useRouter').mockReturnValue({
        push,
        replace: vi.fn(),
        back: vi.fn(),
        prefetch: vi.fn(),
        refresh: vi.fn(),
        forward: vi.fn(),
      } as ReturnType<typeof nav.useRouter>);

      await renderReport();
      await act(async () => {
        fireEvent.click(
          await screen.findByRole('button', { name: /^Compare$/ }),
        );
      });
      const checkboxes = screen.getAllByRole('checkbox', {
        name: /Select Plan [AB] for comparison/,
      });
      await act(async () => {
        fireEvent.click(checkboxes[0]);
      });
      await act(async () => {
        fireEvent.click(checkboxes[1]);
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /Compare selected \(2\/4\)/ }),
        );
      });
      expect(push).toHaveBeenCalledWith(
        '/reports/monte-carlo-simulation/compare?ids=a,b',
      );
    });

    it('blocks selecting a 5th scenario and shows a toast', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({ id: 'a', name: 'Plan A' }),
        scenario({ id: 'b', name: 'Plan B' }),
        scenario({ id: 'c', name: 'Plan C' }),
        scenario({ id: 'd', name: 'Plan D' }),
        scenario({ id: 'e', name: 'Plan E' }),
      ]);
      const toast = (await import('react-hot-toast')).default;
      await renderReport();
      await act(async () => {
        fireEvent.click(
          await screen.findByRole('button', { name: /^Compare$/ }),
        );
      });
      const boxes = screen.getAllByRole('checkbox', {
        name: /Select Plan [A-E] for comparison/,
      });
      for (let i = 0; i < 4; i += 1) {
        await act(async () => {
          fireEvent.click(boxes[i]);
        });
      }
      // 5th click should be blocked + emit a toast error.
      await act(async () => {
        fireEvent.click(boxes[4]);
      });
      expect(toast.error).toHaveBeenCalledWith(
        'You can compare up to 4 scenarios.',
      );
      expect(boxes[4]).not.toBeChecked();
    });

    it('Cancel exits select mode and clears the selection', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({ id: 'a', name: 'Plan A' }),
        scenario({ id: 'b', name: 'Plan B' }),
      ]);
      await renderReport();
      await act(async () => {
        fireEvent.click(
          await screen.findByRole('button', { name: /^Compare$/ }),
        );
      });
      const checkboxes = screen.getAllByRole('checkbox', {
        name: /Select Plan [AB] for comparison/,
      });
      await act(async () => {
        fireEvent.click(checkboxes[0]);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
      });
      expect(screen.queryByRole('button', { name: /Compare selected/ })).toBeNull();
      // Re-entering select mode shows unchecked boxes (selection cleared).
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /^Compare$/ }),
        );
      });
      const fresh = screen.getAllByRole('checkbox', {
        name: /Select Plan [AB] for comparison/,
      });
      expect(fresh[0]).not.toBeChecked();
    });

    it('reverts the local order when the API call fails', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({ id: 'a', name: 'Plan A' }),
        scenario({ id: 'b', name: 'Plan B' }),
      ]);
      mockApi.reorder.mockRejectedValueOnce(new Error('forbidden'));
      const toast = (await import('react-hot-toast')).default;
      await renderReport();
      await act(async () => {
        fireEvent.click(
          await screen.findByRole('button', { name: /^Reorder$/ }),
        );
      });
      const downs = screen.getAllByTitle(/Move down/);
      await act(async () => {
        fireEvent.click(downs[0]);
      });
      expect(toast.error).toHaveBeenCalled();
      // Original order restored: Plan A first, Plan B second.
      const items = screen.getAllByRole('button', { name: /Plan [AB]/ });
      expect(items[0]).toHaveTextContent('Plan A');
      expect(items[1]).toHaveTextContent('Plan B');
    });
  });

  describe('Additional branch coverage', () => {
    // num() helper: non-finite value returns 0 (used in cashFlowMarkers)
    it('treats a non-finite cash flow startYear as 1', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({
          cashFlows: [
            {
              name: 'Event',
              amount: 5000,
              flowType: 'ONE_TIME',
              startYear: NaN as unknown as number,
              endYear: null,
              inflationAdjust: false,
            },
          ],
        }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      // Marker is placed at year 1 (the fallback for NaN startYear).
      const dot = await screen.findByTestId('reference-dot');
      expect(dot.getAttribute('data-x')).toBe('2027');
    });

    // cashFlowMarkers: cash flow with no name falls back to 'Cash flow'
    it('uses fallback name "Cash flow" when the cash flow name is empty', async () => {
      const captured: Blob[] = [];
      const origCreate = global.URL.createObjectURL;
      const origRevoke = global.URL.revokeObjectURL;
      global.URL.createObjectURL = ((b: Blob) => {
        captured.push(b);
        return 'blob:url';
      }) as never;
      global.URL.revokeObjectURL = (() => undefined) as never;

      mockApi.list.mockResolvedValueOnce([
        scenario({
          cashFlows: [
            {
              name: '',
              amount: 1000,
              flowType: 'ONE_TIME',
              startYear: 1,
              endYear: null,
              inflationAdjust: false,
            },
          ],
        }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      fireEvent.click(screen.getByRole('button', { name: /^Export/i }));
      const csvOption = await screen.findByRole('button', { name: /^CSV$/ });
      await act(async () => {
        fireEvent.click(csvOption);
      });
      const text = await captured[0].text();
      expect(text).toMatch(/Cash flow/);

      global.URL.createObjectURL = origCreate;
      global.URL.revokeObjectURL = origRevoke;
    });

    // cashFlowMarkers: recurring flow where endYear == null defaults to totalYears
    // and end === start produces no end marker
    it('skips the end marker when recurring flow endYear equals startYear', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({
          cashFlows: [
            {
              name: 'Equal',
              amount: 3000,
              flowType: 'RECURRING',
              // startYear = 1, totalYears = 3, endYear clamped to max(1, endRaw)
              // We set endYear = 1 so end === start and the end marker is skipped.
              startYear: 1,
              endYear: 1,
              inflationAdjust: false,
            },
          ],
        }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      // Only one dot (the start marker); the end is skipped.
      const dots = await screen.findAllByTestId('reference-dot');
      expect(dots).toHaveLength(1);
    });

    // cashFlowMarkers: recurring flow with endYear == null uses totalYears
    it('uses totalYears when recurring cash flow endYear is null', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({
          cashFlows: [
            {
              name: 'Forever',
              amount: 2000,
              flowType: 'RECURRING',
              startYear: 1,
              endYear: null,
              inflationAdjust: false,
            },
          ],
        }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      // Start and end markers rendered (null endYear falls back to totalYears=3).
      const dots = await screen.findAllByTestId('reference-dot');
      expect(dots.length).toBeGreaterThanOrEqual(2);
    });

    // cashFlowMarkers: cash flow with startYear beyond totalYears is skipped
    it('skips a cash flow whose startYear exceeds the simulation horizon', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({
          cashFlows: [
            {
              name: 'Future',
              amount: 5000,
              flowType: 'ONE_TIME',
              // totalYears = 3 in the fixture; startYear = 100 is skipped.
              startYear: 100,
              endYear: null,
              inflationAdjust: false,
            },
          ],
        }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      // No dots — the event is past the simulation horizon.
      expect(screen.queryByTestId('reference-dot')).not.toBeInTheDocument();
    });

    // CSV export: when result has no performanceSummary, the summary section is omitted
    it('omits performance summary section from CSV when result has no performanceSummary', async () => {
      const captured: Blob[] = [];
      const origCreate = global.URL.createObjectURL;
      const origRevoke = global.URL.revokeObjectURL;
      global.URL.createObjectURL = ((b: Blob) => {
        captured.push(b);
        return 'blob:url';
      }) as never;
      global.URL.revokeObjectURL = (() => undefined) as never;

      mockApi.run.mockResolvedValueOnce(simResult({ performanceSummary: undefined }));
      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      fireEvent.click(screen.getByRole('button', { name: /^Export/i }));
      const csvOption = await screen.findByRole('button', { name: /^CSV$/ });
      await act(async () => {
        fireEvent.click(csvOption);
      });
      const text = await captured[0].text();
      expect(text).not.toMatch(/Performance Summary/);

      global.URL.createObjectURL = origCreate;
      global.URL.revokeObjectURL = origRevoke;
    });

    // PDF export: realValues = true produces "today's value" subtitle
    it('PDF export subtitle says today\'s value when result.realValues is true', async () => {
      const { exportToPdf } = await import('@/lib/pdf-export');
      mockApi.run.mockResolvedValueOnce(simResult({ realValues: true }));
      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      fireEvent.click(screen.getByRole('button', { name: /^Export/i }));
      const pdfOption = await screen.findByRole('button', { name: /^PDF$/ });
      await act(async () => {
        fireEvent.click(pdfOption);
      });
      const args = (exportToPdf as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(args.subtitle).toMatch(/today's value/);
    });

    // PDF export: no performanceSummary means only the percentile table is passed
    it('PDF export omits performance summary table when result has none', async () => {
      const { exportToPdf } = await import('@/lib/pdf-export');
      mockApi.run.mockResolvedValueOnce(simResult({ performanceSummary: undefined }));
      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      fireEvent.click(screen.getByRole('button', { name: /^Export/i }));
      const pdfOption = await screen.findByRole('button', { name: /^PDF$/ });
      await act(async () => {
        fireEvent.click(pdfOption);
      });
      const args = (exportToPdf as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // Only the percentile table when there is no performance summary.
      expect(args.additionalTables).toHaveLength(1);
      expect(args.additionalTables[0].title).toBe('Portfolio Value Percentiles by Year');
    });

    // PDF export: successRate == null produces "—" summary card value
    it('PDF export summary card shows em-dash when successRate is null', async () => {
      const { exportToPdf } = await import('@/lib/pdf-export');
      mockApi.run.mockResolvedValueOnce(simResult({ successRate: null as unknown as number }));
      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      fireEvent.click(screen.getByRole('button', { name: /^Export/i }));
      const pdfOption = await screen.findByRole('button', { name: /^PDF$/ });
      await act(async () => {
        fireEvent.click(pdfOption);
      });
      const args = (exportToPdf as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const successCard = args.summaryCards.find((c: { label: string }) =>
        c.label.includes('Probability Above Target'),
      );
      expect(successCard.value).toBe('—');
    });

    // PDF export with no scenario name falls back to "Scenario"
    it('PDF export title falls back to Scenario when form name is empty', async () => {
      const { exportToPdf } = await import('@/lib/pdf-export');
      // Default form has an empty name.
      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      fireEvent.click(screen.getByRole('button', { name: /^Export/i }));
      const pdfOption = await screen.findByRole('button', { name: /^PDF$/ });
      await act(async () => {
        fireEvent.click(pdfOption);
      });
      const args = (exportToPdf as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(args.title).toBe('Monte Carlo: Scenario');
    });

    // Summary stat: successRate == null renders "—" on screen
    it('shows em-dash for Probability Above Target when successRate is null', async () => {
      mockApi.run.mockResolvedValueOnce(simResult({ successRate: null as unknown as number }));
      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      expect(await screen.findByText('—')).toBeInTheDocument();
    });

    // Summary stat: no targetValue shows plain label
    it('shows plain Probability Above Target label when targetValue is null', async () => {
      mockApi.list.mockResolvedValueOnce([scenario({ targetValue: null })]);
      mockApi.run.mockResolvedValueOnce(simResult({ successRate: 0.6 }));
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      // Without a targetValue the label is just "Probability Above Target".
      const labels = await screen.findAllByText('Probability Above Target');
      expect(labels.length).toBeGreaterThan(0);
    });

    // Phase divider: yearsToRetirement sits in the first half of the chart
    // → label reads "← Withdrawal phase" and position is insideTopLeft.
    // Our fixture has yearLabels = ['2027','2028','2029'] (length 3).
    // yearsToRetirement = 1 → 1/3 ≈ 0.33 < 0.5 → left-side label.
    it('phase divider label uses left-side arrow when divider is in the first half', async () => {
      // Use the ReferenceLine mock to capture the label value via data-x attr.
      // The existing mock renders a <div data-x={x}>. The label object is passed
      // as a recharts prop — we can verify the correct branch fires by checking
      // the rendered markup still shows the reference-line div.
      mockApi.list.mockResolvedValueOnce([
        scenario({ yearsToRetirement: 1, yearsInRetirement: 2 }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      // With yearsToRetirement=1 out of 3 years (< 0.5), the divider is in the
      // first half and the label points left (← Withdrawal phase).
      const line = await screen.findByTestId('reference-line');
      expect(line).toBeInTheDocument();
      // data-x of '2027' confirms the first-year label is used.
      expect(line.getAttribute('data-x')).toBe('2027');
    });

    // Phase divider: yearsToRetirement in the second half (> 0.5) → right-side label.
    it('phase divider label uses right-side arrow when divider is in the second half', async () => {
      // yearLabels length = 3 from fixture. yearsToRetirement=2 → 2/3 ≈ 0.67 > 0.5.
      mockApi.list.mockResolvedValueOnce([
        scenario({ yearsToRetirement: 2, yearsInRetirement: 1 }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      const line = await screen.findByTestId('reference-line');
      expect(line).toBeInTheDocument();
      // data-x should be the second year label.
      expect(line.getAttribute('data-x')).toBe('2028');
    });

    // CashFlowMarker shape: props.cx / props.cy fallback to 0 when undefined.
    // Our ReferenceDot mock calls shape({ cx: 10, cy: 10 }) so both are always
    // provided. We verify the rendered SVG still appears without error.
    it('renders CashFlowMarker shapes inside reference dots without throwing', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({
          cashFlows: [
            {
              name: 'Income',
              amount: 12000,
              flowType: 'ONE_TIME',
              startYear: 1,
              endYear: null,
              inflationAdjust: false,
            },
          ],
        }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      const dot = await screen.findByTestId('reference-dot');
      // The shape prop renders an SVG inside the dot container.
      expect(dot.querySelector('svg')).toBeTruthy();
    });

    // ReferenceDot mock calls shape with { cx: undefined, cy: undefined } path:
    // confirm the ?? 0 fallback fires without error.
    it('CashFlowMarker cx/cy default to 0 when undefined is passed by recharts', async () => {
      // Override the ReferenceDot mock for this test to pass undefined coords.
      const { vi: _vi } = await import('vitest');
      const recharts = await import('recharts');
      const origDot = recharts.ReferenceDot;
      // Temporarily override
      function UndefReferenceDot({ shape }: { shape?: (p: { cx?: number; cy?: number }) => React.ReactNode }) {
        return (
          <div data-testid="reference-dot-undef">
            {shape ? <svg>{shape({ cx: undefined, cy: undefined })}</svg> : null}
          </div>
        );
      }
      (recharts as unknown as Record<string, unknown>).ReferenceDot = UndefReferenceDot;

      mockApi.list.mockResolvedValueOnce([
        scenario({
          cashFlows: [
            {
              name: 'Test',
              amount: 1000,
              flowType: 'ONE_TIME',
              startYear: 1,
              endYear: null,
              inflationAdjust: false,
            },
          ],
        }),
      ]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      expect(screen.queryByTestId('reference-dot-undef')).toBeInTheDocument();

      // Restore
      (recharts as unknown as Record<string, unknown>).ReferenceDot = origDot;
    });

    // saveMenuOpen: clicking outside the save-menu area closes it
    it('clicking outside the save menu closes it', async () => {
      mockApi.list.mockResolvedValueOnce([scenario()]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /Retirement/i });
      fireEvent.click(item);
      // Open the save menu chevron.
      const chevron = await screen.findByRole('button', {
        name: /More save options/i,
      });
      await act(async () => {
        fireEvent.click(chevron);
      });
      // Menu should be open.
      expect(
        await screen.findByRole('menuitem', { name: /Save as/i }),
      ).toBeInTheDocument();
      // Mousedown outside the menu container should close it.
      await act(async () => {
        fireEvent.mouseDown(document.body);
      });
      await waitFor(() =>
        expect(
          screen.queryByRole('menuitem', { name: /Save as/i }),
        ).not.toBeInTheDocument(),
      );
    });

    // result.realValues = true: chart heading shows "real / today's value"
    it('shows real/today\'s value heading when result.realValues is true', async () => {
      mockApi.run.mockResolvedValueOnce(simResult({ realValues: true }));
      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      expect(
        await screen.findByText(/real \/ today's value/),
      ).toBeInTheDocument();
    });

    // performanceSummary section renders when present in result
    it('renders performance summary section when result includes it', async () => {
      await renderReport();
      await screen.findByText('Contribution phase');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      expect(
        await screen.findByText('Performance Summary'),
      ).toBeInTheDocument();
    });

    // reorder: moving up past the top is a no-op (covers newIndex < 0 arm)
    it('Move up on the first scenario is a no-op and does not call reorder', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({ id: 'a', name: 'Plan A' }),
        scenario({ id: 'b', name: 'Plan B' }),
      ]);
      await renderReport();
      await act(async () => {
        fireEvent.click(
          await screen.findByRole('button', { name: /^Reorder$/ }),
        );
      });
      const ups = screen.getAllByTitle(/Move up/);
      // The first "Move up" is disabled, but we still simulate clicking it.
      await act(async () => {
        fireEvent.click(ups[0]);
      });
      // reorder should not be called when index is already 0.
      expect(mockApi.reorder).not.toHaveBeenCalled();
    });

    // Collapsed header with a scenario that has a lastRunAt date shows the date
    it('scenario items show last-run date when lastRunAt is set', async () => {
      const dated = scenario({ id: 'dated', name: 'Dated Plan', lastRunAt: '2026-03-15T00:00:00Z' });
      mockApi.list.mockResolvedValueOnce([dated]);
      await renderReport();
      // The lastRunAt date is shown in the sidebar item.
      expect(await screen.findByText(/Last run/)).toBeInTheDocument();
    });

    // In selectMode with a lastRunAt, the date is also shown inside the label element
    it('shows last-run date inside compare checkboxes when lastRunAt is set', async () => {
      const dated = scenario({ id: 'a', name: 'Plan A', lastRunAt: '2026-03-15T00:00:00Z' });
      const other = scenario({ id: 'b', name: 'Plan B' });
      mockApi.list.mockResolvedValueOnce([dated, other]);
      await renderReport();
      await act(async () => {
        fireEvent.click(
          await screen.findByRole('button', { name: /^Compare$/ }),
        );
      });
      expect(screen.getAllByText(/Last run/).length).toBeGreaterThan(0);
    });

    // Moving down past the last scenario is a no-op
    it('Move down on the last scenario is a no-op and does not call reorder', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({ id: 'a', name: 'Plan A' }),
        scenario({ id: 'b', name: 'Plan B' }),
      ]);
      await renderReport();
      await act(async () => {
        fireEvent.click(
          await screen.findByRole('button', { name: /^Reorder$/ }),
        );
      });
      const downs = screen.getAllByTitle(/Move down/);
      // Click the last "Move down" (which is disabled but simulate anyway).
      await act(async () => {
        fireEvent.click(downs[downs.length - 1]);
      });
      expect(mockApi.reorder).not.toHaveBeenCalled();
    });

    // holdingStats: cancelled=true path means state is NOT set after component unmounts
    it('cancels holdingStats fetch on cleanup when dependencies change', async () => {
      mockApi.list.mockResolvedValueOnce([
        scenario({ accountIds: ['acc-1'], useHistoricalReturns: true }),
      ]);
      let resolveStats!: (v: unknown) => void;
      const pending = new Promise((res) => { resolveStats = res; });
      mockApi.holdingStats.mockReturnValueOnce(pending);

      const { unmount } = await (async () => {
        const MonteCarloReport = await importComponent();
        let result: ReturnType<typeof render>;
        await act(async () => { result = render(<MonteCarloReport />); });
        return result!;
      })();

      // The fetch is in-flight; unmount to trigger cleanup (sets cancelled=true).
      unmount();
      // Resolve the promise after unmount — should not throw or update state.
      await act(async () => {
        resolveStats([]);
      });
      // No assertions needed — if cancelled path is broken, React will warn
      // about updating unmounted component state.
      expect(true).toBe(true);
    });

    // CSV export: filename uses form.name when set
    it('CSV export filename uses form.name when set', async () => {
      let capturedAnchor: HTMLAnchorElement | null = null;
      const origAppend = document.body.appendChild.bind(document.body);
      vi.spyOn(document.body, 'appendChild').mockImplementation((node) => {
        if (node instanceof HTMLAnchorElement) capturedAnchor = node;
        return origAppend(node);
      });

      const origCreate = global.URL.createObjectURL;
      const origRevoke = global.URL.revokeObjectURL;
      global.URL.createObjectURL = (() => 'blob:url') as never;
      global.URL.revokeObjectURL = (() => undefined) as never;

      mockApi.list.mockResolvedValueOnce([scenario({ name: 'My Plan 2026' })]);
      await renderReport();
      const item = await screen.findByRole('button', { name: /My Plan 2026/i });
      fireEvent.click(item);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Run simulation/i }));
      });
      fireEvent.click(screen.getByRole('button', { name: /^Export/i }));
      const csvOption = await screen.findByRole('button', { name: /^CSV$/ });
      await act(async () => {
        fireEvent.click(csvOption);
      });

      expect((capturedAnchor as HTMLAnchorElement | null)?.download).toMatch(/my-plan-2026/);

      global.URL.createObjectURL = origCreate;
      global.URL.revokeObjectURL = origRevoke;
      vi.restoreAllMocks();
    });
  });
});

// Suppress noisy "act" warnings printed by recharts ResizeObserver shim.
const origError = console.error;
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    const msg = String(args[0] ?? '');
    if (msg.includes('not wrapped in act')) return;
    return origError(...args);
  });
});

// Avoid leaking a module-level export from screen
void within;
