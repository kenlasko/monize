import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@/test/render';
import { usePreferencesStore } from '@/store/preferencesStore';
import { exportToPdf } from '@/lib/pdf-export';
import { CustomReportViewer } from './CustomReportViewer';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/lib/pdf-export', () => ({ exportToPdf: vi.fn() }));
vi.mock('@/lib/investment-reports', () => ({
  investmentReportsApi: { getAll: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@/lib/custom-reports', () => ({
  customReportsApi: {
    getAll: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue({
      id: 'report', name: 'Purchases', viewType: 'TABLE', groupBy: 'CATEGORY',
      filters: {}, config: { direction: 'BOTH', metric: 'TOTAL_AMOUNT' },
    }),
    execute: vi.fn().mockResolvedValue({
      viewType: 'TABLE', groupBy: 'CATEGORY', currency: 'USD', signedTotal: true,
      data: [{ id: 'food', label: 'Food', value: -15.25, count: 1 }],
      summary: { total: -15.25, knownTotal: -15.25, count: 1 },
      timeframe: { label: 'November', startDate: '2026-11-01', endDate: '2026-11-30' },
    }),
  },
}));

const initialPreferences = usePreferencesStore.getState().preferences;
afterEach(() => {
  cleanup();
  usePreferencesStore.setState({ preferences: initialPreferences });
});

it('keeps USD and its cents on screen and in the PDF when the cached preference is JPY', async () => {
  usePreferencesStore.getState().updatePreferences({ defaultCurrency: 'JPY', numberFormat: 'en-US' });
  await act(async () => { render(<CustomReportViewer reportId="report" />); });

  const table = await screen.findByRole('table');
  expect(within(table).getAllByText('-$15.25')).toHaveLength(2);
  expect(screen.getAllByText('-$15.25')).toHaveLength(3);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Export' })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'PDF' })); });
  expect(exportToPdf).toHaveBeenCalledWith(expect.objectContaining({
    tableData: expect.objectContaining({
      rows: [expect.arrayContaining(['Food', '-$15.25'])],
      totalRow: expect.arrayContaining(['-$15.25']),
    }),
  }));
});
