import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { AxiosError, AxiosHeaders } from 'axios';
import toast from 'react-hot-toast';
import { act, fireEvent, render, screen, waitFor, within } from '@/test/render';
import { BankSyncPreviewModal } from './BankSyncPreviewModal';
import type { BankSyncPreview, BankSyncPreviewRow, BankSyncResult } from '@/types/bank-sync';

const mockPreviewAccount = vi.fn();
const mockSyncAccount = vi.fn();
const mockRemoveExceptions = vi.fn();

vi.mock('@/lib/bank-sync', () => ({
  bankSyncApi: {
    previewAccount: (...args: unknown[]) => mockPreviewAccount(...args),
    syncAccount: (...args: unknown[]) => mockSyncAccount(...args),
    removeExceptions: (...args: unknown[]) => mockRemoveExceptions(...args),
  },
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (amount: number, code?: string) => `${code ?? '???'} ${amount.toFixed(2)}`,
      formatNumber: (amount: number) => `n ${amount.toFixed(2)}`,
    }),
  };
});

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    formatDate: (d: string) => `on ${d.slice(0, 10)}`,
    dateFormat: 'YYYY-MM-DD',
    datePattern: 'YYYY-MM-DD',
  }),
}));

const FINGERPRINT = 'ab'.repeat(32);

const row = (over: Partial<BankSyncPreviewRow> = {}): BankSyncPreviewRow => ({
  outcome: 'new',
  externalKey: null,
  refusalReason: null,
  transactionDate: '2026-09-10',
  amount: '-50.0000',
  currencyCode: 'PLN',
  payeeText: 'Biedronka',
  description: 'Groceries',
  referenceNumber: null,
  payeeName: 'Biedronka',
  categoryName: 'Food',
  tagNames: [],
  payee: null,
  rules: [],
  operationTag: null,
  ...over,
});

const preview = (over: Partial<BankSyncPreview> = {}): BankSyncPreview => ({
  bankAccountId: 'ba-1',
  currencyCode: 'PLN',
  rows: [
    row({ externalKey: 'ref:r1' }),
    row({
      externalKey: 'ref:r2',
      payeeText: 'Employer',
      payeeName: 'Employer',
      categoryName: null,
      amount: '1200.1234',
    }),
    row({ outcome: 'duplicate', externalKey: 'ref:r3', payeeText: 'Kiosk', payeeName: null, categoryName: null }),
    row({
      outcome: 'refused',
      refusalReason: 'currency_mismatch',
      payeeText: 'Abroad',
      payeeName: null,
      categoryName: null,
      currencyCode: 'EUR',
      amount: '-5.0000',
    }),
    row({ outcome: 'pending', payeeText: 'Later', payeeName: null, categoryName: null }),
    row({ outcome: 'before_cutoff', payeeText: 'Old', payeeName: null, categoryName: null }),
  ],
  labels: { categories: {}, payees: {}, tags: {} },
  summary: {
    new: 2,
    duplicate: 1,
    excluded: 0,
    refused: 1,
    refusedByReason: { currency_mismatch: 1 },
    pending: 1,
    beforeCutoff: 1,
  },
  monizeBalance: '1000.0000',
  balanceAfter: '2150.1234',
  bankBalance: { amount: '2200.1234', currencyCode: 'PLN', referenceDate: '2026-09-29' },
  difference: '50.0000',
  planFingerprint: FINGERPRINT,
  ...over,
});

const result = (over: Partial<BankSyncResult> = {}): BankSyncResult => ({
  bankAccountId: 'ba-1',
  imported: 2,
  skipped: 0,
  refused: {},
  pending: 0,
  beforeCutoff: 0,
  bankBalance: null,
  ...over,
});

const axiosFailure = (status?: number, message = `Server said ${status}`) =>
  new AxiosError(
    'failed',
    status === undefined ? 'ECONNABORTED' : 'ERR_BAD_RESPONSE',
    undefined,
    undefined,
    status === undefined
      ? undefined
      : {
          status,
          statusText: '',
          headers: {},
          config: { headers: new AxiosHeaders() },
          data: { message },
        },
  );

function renderModal(over: { strict?: boolean } = {}) {
  const props = {
    onClose: vi.fn(),
    onImported: vi.fn(),
    onOutcomeUnknown: vi.fn(),
  };
  const modal = (
    <BankSyncPreviewModal isOpen bankAccountId="ba-1" accountName="Checking" {...props} />
  );
  const view = render(over.strict ? <StrictMode>{modal}</StrictMode> : modal);
  return { ...props, ...view };
}

const loaded = async (over: { strict?: boolean } = {}) => {
  let view!: ReturnType<typeof renderModal>;
  await act(async () => {
    view = renderModal(over);
  });
  return view;
};

const tab = (name: RegExp | string) => screen.getByRole('tab', { name });
const bodyRows = () => within(screen.getByRole('tabpanel')).getAllByRole('row').slice(1);

const PHONE_QUERY = '(max-width: 639px)';
const originalMatchMedia = window.matchMedia;

/** Answer `true` only for the phone query `useIsMobile` asks. */
function setPhoneViewport(isPhone: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: isPhone && query === PHONE_QUERY,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPreviewAccount.mockResolvedValue(preview());
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe('BankSyncPreviewModal', () => {
  describe('reading the bank', () => {
    it('asks for the preview of the account once, when it opens, and says it is reading', async () => {
      mockPreviewAccount.mockReturnValue(new Promise(() => {}));
      await loaded();
      expect(mockPreviewAccount).toHaveBeenCalledTimes(1);
      expect(mockPreviewAccount).toHaveBeenCalledWith('ba-1');
      expect(screen.getByText('Preview import into Checking')).toBeInTheDocument();
      expect(screen.getByText('Reading the bank...')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Import|Confirm/ })).toBeDisabled();
    });

    it('does not read the bank twice when React runs the effect twice (a read takes the account\'s lease)', async () => {
      await loaded({ strict: true });
      expect(mockPreviewAccount).toHaveBeenCalledTimes(1);
      expect(await screen.findByText('Monize balance now')).toBeInTheDocument();
    });

    it('says nothing is imported until the person confirms', async () => {
      await loaded();
      expect(screen.getByText(/Nothing is imported until you confirm/)).toBeInTheDocument();
    });

    it('shows the server\'s message when the read fails, and reads again on request', async () => {
      mockPreviewAccount.mockRejectedValueOnce(axiosFailure(409, 'A sync of this account is already running.'));
      await loaded();
      expect(await screen.findByRole('alert')).toHaveTextContent('A sync of this account is already running.');
      expect(screen.getByRole('button', { name: /Import|Confirm/ })).toBeDisabled();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      });
      expect(mockPreviewAccount).toHaveBeenCalledTimes(2);
      expect(await screen.findByText('Monize balance now')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('falls back to its own words when the failure carries none', async () => {
      mockPreviewAccount.mockRejectedValueOnce(axiosFailure(503, ''));
      await loaded();
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not preview this account');
    });
  });

  describe('the summary', () => {
    it('shows the Monize balance now and after the import, and the bank balance with its date', async () => {
      await loaded();
      expect(await screen.findByText('PLN 1000.00')).toBeInTheDocument();
      expect(screen.getByText('Monize balance after the import')).toBeInTheDocument();
      expect(screen.getByText('PLN 2150.12')).toBeInTheDocument();
      expect(screen.getByText('PLN 2200.12 as of on 2026-09-29')).toBeInTheDocument();
    });

    it('shows the difference after the import when both balances are known in one currency', async () => {
      await loaded();
      await screen.findByText('Difference after the import');
      expect(screen.getByText('PLN 50.00')).toBeInTheDocument();
    });

    it('shows a known zero difference as a number', async () => {
      mockPreviewAccount.mockResolvedValue(preview({ difference: '0.0000' }));
      await loaded();
      await screen.findByText('Difference after the import');
      expect(screen.getByText('PLN 0.00')).toBeInTheDocument();
    });

    it('says the bank reported no balance, and shows no difference', async () => {
      mockPreviewAccount.mockResolvedValue(preview({ bankBalance: null, difference: null }));
      await loaded();
      expect(await screen.findByText('Not reported by the bank')).toBeInTheDocument();
      expect(screen.queryByText('Difference after the import')).not.toBeInTheDocument();
    });

    it('hides the difference and says why when the bank balance is in another currency', async () => {
      mockPreviewAccount.mockResolvedValue(
        preview({
          bankBalance: { amount: '10.0000', currencyCode: 'EUR', referenceDate: null },
          difference: null,
        }),
      );
      await loaded();
      expect(await screen.findByText('EUR 10.00')).toBeInTheDocument();
      expect(screen.queryByText('Difference after the import')).not.toBeInTheDocument();
      expect(
        screen.getByText(/The bank balance is in EUR and the Monize account is in PLN/),
      ).toBeInTheDocument();
    });
  });

  describe('the rows and the filter tabs', () => {
    it('counts every tab and opens on the new rows', async () => {
      await loaded();
      await screen.findByText('Monize balance now');
      expect(tab('All (6)')).toBeInTheDocument();
      expect(tab('New (2)')).toHaveAttribute('aria-selected', 'true');
      expect(tab('Already imported (1)')).toBeInTheDocument();
      expect(tab('Refused (1)')).toBeInTheDocument();
      expect(tab('Pending (1)')).toBeInTheDocument();
      expect(tab('Before the start date (1)')).toBeInTheDocument();
      expect(bodyRows()).toHaveLength(2);
    });

    it('opens on all rows when nothing is new', async () => {
      mockPreviewAccount.mockResolvedValue(
        preview({
          rows: [row({ outcome: 'duplicate' })],
          summary: { new: 0, duplicate: 1, excluded: 0, refused: 0, refusedByReason: {}, pending: 0, beforeCutoff: 0 },
        }),
      );
      await loaded();
      await screen.findByText('Monize balance now');
      expect(tab('All (1)')).toHaveAttribute('aria-selected', 'true');
      expect(bodyRows()).toHaveLength(1);
    });

    it('shows one outcome\'s rows per tab, and all of them under All', async () => {
      await loaded();
      await screen.findByText('Monize balance now');

      fireEvent.click(tab('All (6)'));
      expect(bodyRows()).toHaveLength(6);

      fireEvent.click(tab('Already imported (1)'));
      expect(bodyRows()).toHaveLength(1);
      expect(within(screen.getByRole('tabpanel')).getByText('Kiosk')).toBeInTheDocument();

      fireEvent.click(tab('Refused (1)'));
      expect(within(screen.getByRole('tabpanel')).getByText('Abroad')).toBeInTheDocument();
      expect(within(screen.getByRole('tabpanel')).queryByText('Kiosk')).not.toBeInTheDocument();
    });

    it('shows the date, payee, category, description and signed amount of a new row', async () => {
      await loaded();
      await screen.findByText('Monize balance now');
      const first = bodyRows()[0];
      expect(within(first).getByText('on 2026-09-10')).toBeInTheDocument();
      expect(within(first).getByText('Biedronka')).toBeInTheDocument();
      expect(within(first).getByText('Groceries')).toBeInTheDocument();
      expect(within(first).getByText('Food')).toBeInTheDocument();
      expect(within(first).getByText('PLN -50.00')).toBeInTheDocument();
      expect(within(bodyRows()[1]).getByText('PLN 1200.12')).toBeInTheDocument();
    });

    it('draws an address in the bank\'s description as a link, as the register will once it is imported', async () => {
      mockPreviewAccount.mockResolvedValue(
        preview({ rows: [row({ description: 'Order https://shop.example/o/42 paid' })] }),
      );
      await loaded();
      await screen.findByText('Monize balance now');
      const link = within(bodyRows()[0]).getByRole('link', { name: 'https://shop.example/o/42' });
      expect(link).toHaveAttribute('href', 'https://shop.example/o/42');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('names the outcome of each row with a badge', async () => {
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(tab('All (6)'));
      const rows = bodyRows();
      // Each status is drawn twice (one for the phone, one from `sm`), so ask by row.
      expect(within(rows[0]).getAllByText('New').length).toBeGreaterThan(0);
      expect(within(rows[2]).getAllByText('Already imported').length).toBeGreaterThan(0);
      expect(within(rows[3]).getAllByText('Other currency').length).toBeGreaterThan(0);
      expect(within(rows[4]).getAllByText('Pending').length).toBeGreaterThan(0);
      expect(within(rows[5]).getAllByText('Before the start date').length).toBeGreaterThan(0);
    });

    it('shows a refused row in the currency the bank sent it in, never the account\'s', async () => {
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(tab('Refused (1)'));
      expect(within(bodyRows()[0]).getByText('EUR -5.00')).toBeInTheDocument();
    });

    it('names a refusal reason it has no sentence for as refused', async () => {
      mockPreviewAccount.mockResolvedValue(
        preview({
          rows: [row({ outcome: 'refused', refusalReason: 'brand_new_reason', currencyCode: 'PLN' })],
          summary: { new: 0, duplicate: 0, excluded: 0, refused: 1, refusedByReason: {}, pending: 0, beforeCutoff: 0 },
        }),
      );
      await loaded();
      await screen.findByText('Monize balance now');
      expect(within(bodyRows()[0]).getAllByText('Refused').length).toBeGreaterThan(0);
    });

    it('shows an amount the bank sent unreadable as unknown, not zero', async () => {
      mockPreviewAccount.mockResolvedValue(
        preview({
          rows: [row({ outcome: 'refused', refusalReason: 'invalid_amount', amount: null })],
          summary: { new: 0, duplicate: 0, excluded: 0, refused: 1, refusedByReason: {}, pending: 0, beforeCutoff: 0 },
        }),
      );
      await loaded();
      await screen.findByText('Monize balance now');
      expect(within(bodyRows()[0]).getByText('Unknown')).toBeInTheDocument();
      expect(within(bodyRows()[0]).queryByText(/0\.00/)).not.toBeInTheDocument();
    });

    it('shows a row without a date or a payee as such', async () => {
      mockPreviewAccount.mockResolvedValue(
        preview({
          rows: [row({ transactionDate: null, payeeText: null, payeeName: null, description: null })],
        }),
      );
      await loaded();
      await screen.findByText('Monize balance now');
      const only = bodyRows()[0];
      expect(within(only).getByText('No date')).toBeInTheDocument();
      expect(within(only).getByText('No payee')).toBeInTheDocument();
    });

    it('shows the tags the import rules would add', async () => {
      mockPreviewAccount.mockResolvedValue(preview({ rows: [row({ tagNames: ['Weekly', 'Food'] })] }));
      await loaded();
      await screen.findByText('Monize balance now');
      expect(within(bodyRows()[0]).getByText('Weekly')).toBeInTheDocument();
    });

    it('says so when the bank returned nothing, and when a tab is empty', async () => {
      mockPreviewAccount.mockResolvedValue(
        preview({
          rows: [],
          summary: { new: 0, duplicate: 0, excluded: 0, refused: 0, refusedByReason: {}, pending: 0, beforeCutoff: 0 },
        }),
      );
      await loaded();
      expect(
        await screen.findByText('The bank returned no transactions for this period.'),
      ).toBeInTheDocument();
      fireEvent.click(tab('Pending (0)'));
      expect(screen.getByText('No transactions in this list.')).toBeInTheDocument();
    });
  });

  describe('the layout', () => {
    it('opens in the widest modal and fills a phone', async () => {
      await loaded();
      await screen.findByText('Monize balance now');
      const dialog = screen.getByRole('dialog');
      expect(dialog.className).toContain('max-w-6xl');
      expect(dialog.className).toContain('max-sm:h-dvh');
    });

    it('is a fixed-height column: the rows are the one scroll area and the footer is pinned', async () => {
      await loaded();
      await screen.findByText('Monize balance now');
      const dialog = screen.getByRole('dialog');
      // The panel neither scrolls nor guesses a height from the viewport.
      expect(dialog.className).toContain('h-[min(90vh,56rem)]');
      expect(dialog.className).toContain('flex-col');
      expect(dialog.className).toContain('overflow-hidden');
      expect(dialog.className).not.toContain('overflow-y-auto');
      expect(dialog.className).not.toContain('max-h-[90vh]');
      expect(dialog.outerHTML).not.toContain('calc(');

      // Header on top, footer at the bottom, neither one squeezed by the rows.
      const heading = within(dialog).getByRole('heading', { level: 2 });
      expect(heading.parentElement!.parentElement!.className).toContain('shrink-0');
      // The header's close icon comes first; the footer's Close button is the last.
      const closeButton = within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!;
      const footer = closeButton.closest('div.border-t') as HTMLElement;
      expect(footer.className).toContain('shrink-0');
      expect(footer.parentElement).toBe(dialog);
      expect(dialog.lastElementChild).toBe(footer);

      // Between them, the body takes the rest and the rows scroll inside it.
      const panel = screen.getByRole('tabpanel');
      expect(panel.className).toContain('flex-1');
      expect(panel.className).toContain('min-h-0');
      const scroller = within(panel).getByRole('table').parentElement as HTMLElement;
      expect(scroller.className).toContain('flex-1');
      expect(scroller.className).toContain('overflow-y-auto');
      // The summary and the tabs keep their own height above the rows.
      const summary = screen.getByText('Monize balance now').closest('dl') as HTMLElement;
      expect(summary.parentElement!.className).toContain('shrink-0');
      expect(summary.parentElement!.contains(screen.getByRole('tablist'))).toBe(true);
    });

    it('scrolls the cards, not the dialog, on a phone', async () => {
      setPhoneViewport(true);
      await loaded();
      await screen.findByText('Monize balance now');
      const dialog = screen.getByRole('dialog');
      expect(dialog.className).toContain('max-sm:h-dvh');
      const list = within(screen.getByRole('tabpanel')).getByRole('list');
      expect(list.className).toContain('flex-1');
      expect(list.className).toContain('overflow-y-auto');
      expect(list.className).not.toContain('max-h-');
    });

    it('lays the summary out in two columns from sm', async () => {
      await loaded();
      await screen.findByText('Monize balance now');
      const summary = screen.getByText('Monize balance now').closest('dl') as HTMLElement;
      expect(summary.className).toContain('grid-cols-1');
      expect(summary.className).toContain('sm:grid-cols-2');
    });

    it('draws six fixed-width columns, with the category hidden below lg', async () => {
      await loaded();
      await screen.findByText('Monize balance now');
      const panel = screen.getByRole('tabpanel');
      const headers = within(panel).getAllByRole('columnheader');
      expect(headers.map((h) => h.textContent)).toEqual([
        'Select and details',
        'Date',
        'Payee',
        'Category',
        'Amount',
        'Status',
      ]);
      // Only the category column gives way, and only below lg.
      expect(headers[3].className).toContain('hidden');
      expect(headers[3].className).toContain('lg:table-cell');
      expect(headers[0].className).not.toContain('hidden');
      expect(headers[1].className).not.toContain('hidden');
      expect(headers[4].className).not.toContain('hidden');
      expect(headers[5].className).not.toContain('hidden');
      const table = within(panel).getByRole('table');
      expect(table.className).toContain('table-fixed');
      expect(table.querySelectorAll('colgroup > col')).toHaveLength(6);
    });

    it('keeps the header row in place while the rows scroll, and scrolls only vertically', async () => {
      await loaded();
      await screen.findByText('Monize balance now');
      const panel = screen.getByRole('tabpanel');
      for (const header of within(panel).getAllByRole('columnheader')) {
        expect(header.className).toContain('sticky');
        expect(header.className).toContain('top-0');
      }
      const scroller = within(panel).getByRole('table').parentElement as HTMLElement;
      expect(scroller.className).toContain('overflow-y-auto');
      expect(scroller.className).not.toContain('overflow-x');
    });

    it('prints the amount right-aligned, on one line, coloured by its sign', async () => {
      await loaded();
      await screen.findByText('Monize balance now');
      const [spent, received] = bodyRows();
      const spentCell = within(spent).getByText('PLN -50.00').closest('td') as HTMLElement;
      expect(spentCell.className).toContain('text-right');
      expect(spentCell.className).toContain('whitespace-nowrap');
      expect(spentCell.className).toContain('tabular-nums');
      expect(within(spent).getByText('PLN -50.00').className).toContain('text-red-600');
      expect(within(received).getByText('PLN 1200.12').className).toContain('text-green-600');
    });

    it('gives an amount the bank sent unreadable no sign colour', async () => {
      mockPreviewAccount.mockResolvedValue(
        preview({
          rows: [row({ outcome: 'refused', refusalReason: 'invalid_amount', amount: null })],
          summary: { new: 0, duplicate: 0, excluded: 0, refused: 1, refusedByReason: {}, pending: 0, beforeCutoff: 0 },
        }),
      );
      await loaded();
      await screen.findByText('Monize balance now');
      const unknown = within(bodyRows()[0]).getByText('Unknown');
      expect(unknown.className).not.toMatch(/text-(red|green)-/);
    });

    it('truncates a long payee, description and category and keeps the full text in a title', async () => {
      const longPayee = 'A very long payee name '.repeat(8).trim();
      const longDescription = 'A very long bank description '.repeat(8).trim();
      mockPreviewAccount.mockResolvedValue(
        preview({
          rows: [
            row({
              payeeText: longPayee,
              payeeName: longPayee,
              description: longDescription,
              categoryName: 'Household: Cleaning supplies and more',
            }),
          ],
        }),
      );
      await loaded();
      await screen.findByText('Monize balance now');
      const only = bodyRows()[0];
      const payee = within(only).getByText(longPayee);
      expect(payee).toHaveAttribute('title', longPayee);
      expect(payee.className).toContain('truncate');
      expect(payee.className).toContain('min-w-0');
      const description = within(only).getByText(longDescription).closest('[title]') as HTMLElement;
      expect(description).toHaveAttribute('title', longDescription);
      expect(description.className).toContain('truncate');
      const category = within(only).getByText('Household: Cleaning supplies and more');
      expect(category).toHaveAttribute('title', 'Household: Cleaning supplies and more');
      expect(category.className).toContain('truncate');
    });

    it('puts the description beneath the payee in muted small text', async () => {
      await loaded();
      await screen.findByText('Monize balance now');
      const payeeCell = within(bodyRows()[0]).getByText('Biedronka').closest('td') as HTMLElement;
      const description = within(payeeCell).getByText('Groceries').closest('[title]') as HTMLElement;
      expect(description.className).toContain('text-xs');
      expect(description.className).toContain('text-gray-500');
    });

    it('wraps the outcome tabs instead of scrolling them sideways', async () => {
      await loaded();
      await screen.findByText('Monize balance now');
      const tablist = screen.getByRole('tablist');
      expect(tablist.className).toContain('flex-wrap');
      const scroller = tablist.parentElement as HTMLElement;
      expect(scroller.className).not.toContain('overflow-x-auto');
    });

    describe('on a phone', () => {
      beforeEach(() => setPhoneViewport(true));

      it('draws a card per row and no table', async () => {
        await loaded();
        await screen.findByText('Monize balance now');
        const panel = screen.getByRole('tabpanel');
        expect(within(panel).queryByRole('table')).not.toBeInTheDocument();
        expect(within(panel).queryAllByRole('columnheader')).toHaveLength(0);
        expect(within(panel).getAllByRole('listitem')).toHaveLength(2);
      });

      it('shows the date and amount, then the payee, description and outcome', async () => {
        await loaded();
        await screen.findByText('Monize balance now');
        const [first, second] = within(screen.getByRole('tabpanel')).getAllByRole('listitem');
        expect(within(first).getByText('on 2026-09-10')).toBeInTheDocument();
        const amount = within(first).getByText('PLN -50.00');
        expect(amount.className).toContain('text-red-600');
        expect(amount.className).toContain('tabular-nums');
        const payee = within(first).getByText('Biedronka');
        expect(payee).toHaveAttribute('title', 'Biedronka');
        expect(payee.className).toContain('truncate');
        const description = within(first).getByText('Groceries').closest('[title]') as HTMLElement;
        expect(description.className).toContain('truncate');
        expect(description.className).toContain('text-gray-500');
        expect(within(first).getAllByText('New')).toHaveLength(1);
        expect(within(second).getByText('PLN 1200.12').className).toContain('text-green-600');
      });

      it('follows the tabs and names a refused row in the currency the bank sent it in', async () => {
        await loaded();
        await screen.findByText('Monize balance now');
        fireEvent.click(tab('Refused (1)'));
        const [card] = within(screen.getByRole('tabpanel')).getAllByRole('listitem');
        expect(within(card).getByText('EUR -5.00')).toBeInTheDocument();
        expect(within(card).getByText('Other currency')).toBeInTheDocument();
        expect(within(card).getByText('Abroad')).toBeInTheDocument();
      });

      it('shows an unreadable amount as unknown, and tags and category on the card', async () => {
        mockPreviewAccount.mockResolvedValue(
          preview({
            rows: [row({ amount: null, tagNames: ['Weekly'], categoryName: 'Food' })],
          }),
        );
        await loaded();
        await screen.findByText('Monize balance now');
        const card = within(screen.getByRole('tabpanel')).getAllByRole('listitem')[0];
        expect(within(card).getByText('Unknown')).toBeInTheDocument();
        expect(within(card).getByText('Weekly')).toBeInTheDocument();
        expect(within(card).getByText('Food')).toBeInTheDocument();
      });

      it('keeps the empty state and the import button', async () => {
        await loaded();
        expect(await screen.findByRole('button', { name: 'Import 2 transactions' })).toBeEnabled();
      });
    });
  });

  describe('importing', () => {
    it('says how many transactions it would import', async () => {
      await loaded();
      expect(await screen.findByRole('button', { name: 'Import 2 transactions' })).toBeEnabled();
    });

    it('says one in the singular', async () => {
      mockPreviewAccount.mockResolvedValue(
        preview({
          rows: [row({ externalKey: 'ref:r1' })],
          summary: { ...preview().summary, new: 1, duplicate: 0, refused: 0, pending: 0, beforeCutoff: 0 },
        }),
      );
      await loaded();
      expect(await screen.findByRole('button', { name: 'Import 1 transaction' })).toBeEnabled();
    });

    it('offers to confirm when there is nothing new, so the link can still be confirmed', async () => {
      mockPreviewAccount.mockResolvedValue(
        preview({
          rows: [row({ outcome: 'duplicate', externalKey: 'ref:r3' })],
          summary: { ...preview().summary, new: 0, duplicate: 1, refused: 0, pending: 0, beforeCutoff: 0 },
        }),
      );
      await loaded();
      expect(
        await screen.findByRole('button', { name: 'Confirm: nothing new to import' }),
      ).toBeEnabled();
      // Nothing is new, so there is no choice to summarise.
      expect(screen.queryByText(/skip \d+, add/)).not.toBeInTheDocument();
    });

    it('syncs with the fingerprint of the preview and hands the result on', async () => {
      mockSyncAccount.mockResolvedValue(result());
      const { onImported } = await loaded();
      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: 'Import 2 transactions' }));
      });
      expect(mockSyncAccount).toHaveBeenCalledWith('ba-1', FINGERPRINT, {
        importKeys: ['ref:r1', 'ref:r2'],
        excludeKeys: [],
      });
      await waitFor(() => expect(onImported).toHaveBeenCalledWith(result()));
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('is busy while the import runs, and cannot be fired twice', async () => {
      let resolve!: (value: BankSyncResult) => void;
      mockSyncAccount.mockReturnValue(new Promise<BankSyncResult>((r) => (resolve = r)));
      await loaded();
      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: 'Import 2 transactions' }));
      });
      const busy = screen.getByRole('button', { name: 'Importing...' });
      expect(busy).toBeDisabled();
      fireEvent.click(busy);
      expect(mockSyncAccount).toHaveBeenCalledTimes(1);
      await act(async () => {
        resolve(result());
      });
    });

    it('on a 409 says the data changed, imports nothing, and reads the preview again', async () => {
      mockSyncAccount.mockRejectedValue(axiosFailure(409, 'The bank\'s data changed since the preview.'));
      const { onImported } = await loaded();
      mockPreviewAccount.mockResolvedValue(
        preview({
          rows: [row({ externalKey: 'ref:fresh', payeeText: 'Fresh row', payeeName: 'Fresh row' })],
          summary: { ...preview().summary, new: 1 },
          planFingerprint: 'cd'.repeat(32),
        }),
      );

      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: 'Import 2 transactions' }));
      });

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          'The bank\'s data changed since this preview, so nothing was imported. The preview was read again: check it and import once more.',
        ),
      );
      expect(onImported).not.toHaveBeenCalled();
      expect(mockPreviewAccount).toHaveBeenCalledTimes(2);
      // The new answer is on screen, and confirming it uses its fingerprint.
      expect(await screen.findByText('Fresh row')).toBeInTheDocument();
      mockSyncAccount.mockResolvedValue(result({ imported: 1 }));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Import 1 transaction' }));
      });
      expect(mockSyncAccount).toHaveBeenLastCalledWith('ba-1', 'cd'.repeat(32), {
        importKeys: ['ref:fresh'],
        excludeKeys: [],
      });
    });

    it('shows the server\'s message for any other refusal and keeps the preview', async () => {
      mockSyncAccount.mockRejectedValue(axiosFailure(400, 'The linked account is closed.'));
      const { onImported } = await loaded();
      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: 'Import 2 transactions' }));
      });
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The linked account is closed.'));
      expect(onImported).not.toHaveBeenCalled();
      expect(mockPreviewAccount).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeEnabled();
    });

    it.each([undefined, 500, 504])(
      'does not claim the result when the import\'s outcome is unknown (%p)',
      async (status) => {
        mockSyncAccount.mockRejectedValue(axiosFailure(status));
        const { onOutcomeUnknown, onImported } = await loaded();
        await act(async () => {
          fireEvent.click(await screen.findByRole('button', { name: 'Import 2 transactions' }));
        });
        await waitFor(() => expect(onOutcomeUnknown).toHaveBeenCalledTimes(1));
        expect(onImported).not.toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalled();
      },
    );

    it('closes without importing', async () => {
      const { onClose } = await loaded();
      await screen.findByText('Monize balance now');
      await act(async () => {
        fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1) as HTMLElement);
      });
      expect(onClose).toHaveBeenCalled();
      expect(mockSyncAccount).not.toHaveBeenCalled();
    });
  });

  describe('choosing the rows (spec section 7b)', () => {
    const THREE = () =>
      preview({
        rows: [
          row({ externalKey: 'ref:a', payeeText: 'Alpha', payeeName: 'Alpha' }),
          row({ externalKey: 'ref:b', payeeText: 'Beta', payeeName: 'Beta' }),
          row({ externalKey: 'ref:c', payeeText: 'Gamma', payeeName: 'Gamma' }),
          row({ outcome: 'duplicate', externalKey: 'ref:d', payeeText: 'Done', payeeName: null }),
        ],
        summary: { new: 3, duplicate: 1, excluded: 0, refused: 0, refusedByReason: {}, pending: 0, beforeCutoff: 0 },
      });
    const rowBox = (payee: string) => screen.getByRole('checkbox', { name: `Import ${payee}` }) as HTMLInputElement;
    const headerBox = () =>
      screen.getByRole('checkbox', { name: 'Select all new transactions in this list' }) as HTMLInputElement;

    beforeEach(() => {
      mockPreviewAccount.mockResolvedValue(THREE());
    });

    it('starts with every new row checked, and says what the import would do', async () => {
      await loaded();
      await screen.findByText('Monize balance now');
      for (const payee of ['Alpha', 'Beta', 'Gamma']) expect(rowBox(payee)).toBeChecked();
      expect(headerBox()).toBeChecked();
      expect(screen.getByText('Import 3, skip 0, add 0 to exceptions')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Import 3 transactions' })).toBeEnabled();
    });

    it('gives only the new rows a checkbox', async () => {
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(tab('All (4)'));
      // Three rows' boxes and the header's; the already imported row has none.
      expect(within(screen.getByRole('tabpanel')).getAllByRole('checkbox')).toHaveLength(4);
    });

    it('unchecking a row leaves it out of the count and offers skip now or add to exceptions, skip first', async () => {
      await loaded();
      await screen.findByText('Monize balance now');
      expect(screen.queryByRole('radio')).not.toBeInTheDocument();

      fireEvent.click(rowBox('Beta'));

      expect(rowBox('Beta')).not.toBeChecked();
      expect(screen.getByText('Import 2, skip 1, add 0 to exceptions')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeEnabled();
      const group = screen.getByRole('group', { name: 'What to do with Beta if it is not imported' });
      expect(within(group).getByRole('radio', { name: 'Skip now' })).toBeChecked();
      expect(within(group).getByRole('radio', { name: 'Add to exceptions' })).not.toBeChecked();
    });

    it('adding an unchecked row to the exceptions moves it from skip to exceptions in the summary, and checking it again clears the choice', async () => {
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(rowBox('Beta'));
      fireEvent.click(screen.getByRole('radio', { name: 'Add to exceptions' }));
      expect(screen.getByText('Import 2, skip 0, add 1 to exceptions')).toBeInTheDocument();

      fireEvent.click(rowBox('Beta'));
      expect(screen.getByText('Import 3, skip 0, add 0 to exceptions')).toBeInTheDocument();
      expect(screen.queryByRole('radio')).not.toBeInTheDocument();
      // Unchecked again, it is skipped for now: the earlier choice was forgotten.
      fireEvent.click(rowBox('Beta'));
      expect(screen.getByRole('radio', { name: 'Skip now' })).toBeChecked();
    });

    it('sends the fingerprint with both lists: the checked rows to import and the excepted ones to exclude', async () => {
      mockSyncAccount.mockResolvedValue(result({ imported: 1 }));
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(rowBox('Alpha')); // skipped for now
      fireEvent.click(rowBox('Gamma'));
      fireEvent.click(
        within(screen.getByRole('group', { name: 'What to do with Gamma if it is not imported' })).getByRole('radio', {
          name: 'Add to exceptions',
        }),
      );

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Import 1 transaction' }));
      });

      expect(mockSyncAccount).toHaveBeenCalledWith('ba-1', FINGERPRINT, {
        importKeys: ['ref:b'],
        excludeKeys: ['ref:c'],
      });
    });

    it('the header box selects none, then all, of the new rows in the list', async () => {
      await loaded();
      await screen.findByText('Monize balance now');

      fireEvent.click(headerBox());
      for (const payee of ['Alpha', 'Beta', 'Gamma']) expect(rowBox(payee)).not.toBeChecked();
      expect(headerBox()).not.toBeChecked();
      expect(screen.getByText('Import 0, skip 3, add 0 to exceptions')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Confirm without importing' })).toBeEnabled();

      fireEvent.click(headerBox());
      for (const payee of ['Alpha', 'Beta', 'Gamma']) expect(rowBox(payee)).toBeChecked();
      expect(screen.getByText('Import 3, skip 0, add 0 to exceptions')).toBeInTheDocument();
    });

    it('shows the header box as indeterminate when only some rows are checked, and ticking it checks the rest', async () => {
      await loaded();
      await screen.findByText('Monize balance now');
      expect(headerBox().indeterminate).toBe(false);

      fireEvent.click(rowBox('Beta'));
      expect(headerBox().indeterminate).toBe(true);
      expect(headerBox()).not.toBeChecked();

      fireEvent.click(headerBox());
      for (const payee of ['Alpha', 'Beta', 'Gamma']) expect(rowBox(payee)).toBeChecked();
      expect(headerBox().indeterminate).toBe(false);
      expect(headerBox()).toBeChecked();
    });

    it('confirms with nothing chosen: an empty selection is sent, so nothing is imported and nothing is excepted', async () => {
      mockSyncAccount.mockResolvedValue(result({ imported: 0 }));
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(headerBox());

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Confirm without importing' }));
      });

      expect(mockSyncAccount).toHaveBeenCalledWith('ba-1', FINGERPRINT, { importKeys: [], excludeKeys: [] });
    });

    it('has no header box on a tab with nothing to choose', async () => {
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(tab('Already imported (1)'));
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    });

    it('disables every box and choice while the import runs', async () => {
      let resolve!: (value: BankSyncResult) => void;
      mockSyncAccount.mockReturnValue(new Promise<BankSyncResult>((r) => (resolve = r)));
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(rowBox('Beta'));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Import 2 transactions' }));
      });
      expect(headerBox()).toBeDisabled();
      expect(rowBox('Alpha')).toBeDisabled();
      expect(screen.getByRole('radio', { name: 'Skip now' })).toBeDisabled();
      await act(async () => {
        resolve(result());
      });
    });

    it('keeps the choices about rows the bank still lists as new when the preview is read again after a 409', async () => {
      mockSyncAccount.mockRejectedValue(axiosFailure(409, 'changed'));
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(rowBox('Beta'));
      mockPreviewAccount.mockResolvedValue(
        preview({
          rows: [
            row({ externalKey: 'ref:b', payeeText: 'Beta', payeeName: 'Beta' }),
            row({ externalKey: 'ref:n', payeeText: 'Newcomer', payeeName: 'Newcomer' }),
          ],
          summary: { new: 2, duplicate: 0, excluded: 0, refused: 0, refusedByReason: {}, pending: 0, beforeCutoff: 0 },
          planFingerprint: 'cd'.repeat(32),
        }),
      );

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Import 2 transactions' }));
      });

      expect(await screen.findByText('Newcomer')).toBeInTheDocument();
      // Beta was unchecked and still is; the new row starts checked.
      expect(rowBox('Beta')).not.toBeChecked();
      expect(rowBox('Newcomer')).toBeChecked();
      expect(screen.getByText('Import 1, skip 1, add 0 to exceptions')).toBeInTheDocument();
    });

    it('forgets the choice about a row that is no longer new', async () => {
      mockSyncAccount.mockRejectedValue(axiosFailure(409, 'changed'));
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(rowBox('Beta'));
      mockPreviewAccount.mockResolvedValue(
        preview({
          rows: [row({ externalKey: 'ref:a', payeeText: 'Alpha', payeeName: 'Alpha' })],
          summary: { new: 1, duplicate: 0, excluded: 0, refused: 0, refusedByReason: {}, pending: 0, beforeCutoff: 0 },
        }),
      );
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Import 2 transactions' }));
      });
      await screen.findByRole('checkbox', { name: 'Import Alpha' });
      expect(screen.getByText('Import 1, skip 0, add 0 to exceptions')).toBeInTheDocument();
    });

    describe('on a phone', () => {
      beforeEach(() => setPhoneViewport(true));

      it('puts a checkbox on each new card, a select-all above them and the choice under an unchecked one', async () => {
        await loaded();
        await screen.findByText('Monize balance now');
        const panel = screen.getByRole('tabpanel');
        expect(within(panel).queryByRole('table')).not.toBeInTheDocument();
        expect(within(panel).getAllByRole('listitem')).toHaveLength(3);
        for (const payee of ['Alpha', 'Beta', 'Gamma']) expect(rowBox(payee)).toBeChecked();
        expect(headerBox()).toBeChecked();

        fireEvent.click(rowBox('Beta'));

        const [, beta] = within(panel).getAllByRole('listitem');
        expect(within(beta).getByRole('radio', { name: 'Skip now' })).toBeChecked();
        expect(headerBox().indeterminate).toBe(true);
        fireEvent.click(headerBox());
        for (const payee of ['Alpha', 'Beta', 'Gamma']) expect(rowBox(payee)).toBeChecked();
      });
    });
  });

  describe('the exceptions tab (spec section 7b)', () => {
    const WITH_EXCEPTIONS = () =>
      preview({
        rows: [
          row({ externalKey: 'ref:n', payeeText: 'Fresh', payeeName: 'Fresh' }),
          row({ outcome: 'excluded', externalKey: 'ref:x1', payeeText: 'Mistake', payeeName: null }),
          row({ outcome: 'excluded', externalKey: 'ref:x2', payeeText: 'Duplicate charge', payeeName: null }),
          row({ outcome: 'duplicate', externalKey: 'ref:d', payeeText: 'Done', payeeName: null }),
        ],
        summary: { new: 1, duplicate: 1, excluded: 2, refused: 0, refusedByReason: {}, pending: 0, beforeCutoff: 0 },
      });
    const exceptionBox = (payee: string) =>
      screen.getByRole('checkbox', { name: `Remove ${payee} from the exceptions` }) as HTMLInputElement;
    const removeButton = (name: string | RegExp) => screen.getByRole('button', { name });

    beforeEach(() => {
      mockPreviewAccount.mockResolvedValue(WITH_EXCEPTIONS());
    });

    it('is a tab of its own, counted apart from the rows already imported', async () => {
      await loaded();
      await screen.findByText('Monize balance now');
      expect(tab('Exceptions (2)')).toBeInTheDocument();
      expect(tab('Already imported (1)')).toBeInTheDocument();
      fireEvent.click(tab('Exceptions (2)'));
      expect(bodyRows()).toHaveLength(2);
      expect(within(screen.getByRole('tabpanel')).getByText('Mistake')).toBeInTheDocument();
      expect(within(screen.getByRole('tabpanel')).queryByText('Done')).not.toBeInTheDocument();
      expect(within(bodyRows()[0]).getAllByText('Exception').length).toBeGreaterThan(0);
      expect(
        screen.getByText(/Transactions in the exceptions are never imported/),
      ).toBeInTheDocument();
    });

    it('shows an exception in the All tab as one, with no box to remove it there', async () => {
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(tab('All (4)'));
      expect(within(screen.getByRole('tabpanel')).getByText('Mistake')).toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: 'Remove Mistake from the exceptions' })).not.toBeInTheDocument();
    });

    it('does not count an exception among the rows to import', async () => {
      await loaded();
      expect(await screen.findByRole('button', { name: 'Import 1 transaction' })).toBeEnabled();
      expect(screen.getByText('Import 1, skip 0, add 0 to exceptions')).toBeInTheDocument();
    });

    it('removes the picked exceptions, says how many, and reads the preview again', async () => {
      mockRemoveExceptions.mockResolvedValue({ removed: 1 });
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(tab('Exceptions (2)'));
      expect(removeButton('Remove from exceptions')).toBeDisabled();

      fireEvent.click(exceptionBox('Mistake'));
      expect(removeButton('Remove 1 from exceptions')).toBeEnabled();
      mockPreviewAccount.mockResolvedValue(
        preview({
          rows: [
            row({ externalKey: 'ref:n', payeeText: 'Fresh', payeeName: 'Fresh' }),
            row({ externalKey: 'ref:x1', payeeText: 'Mistake', payeeName: 'Mistake' }),
            row({ outcome: 'excluded', externalKey: 'ref:x2', payeeText: 'Duplicate charge', payeeName: null }),
          ],
          summary: { new: 2, duplicate: 0, excluded: 1, refused: 0, refusedByReason: {}, pending: 0, beforeCutoff: 0 },
        }),
      );
      await act(async () => {
        fireEvent.click(removeButton('Remove 1 from exceptions'));
      });

      expect(mockRemoveExceptions).toHaveBeenCalledWith('ba-1', ['ref:x1']);
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith('1 transaction was removed from the exceptions'),
      );
      expect(mockPreviewAccount).toHaveBeenCalledTimes(2);
      // The row is new again, and checked like every new row.
      expect(await screen.findByRole('checkbox', { name: 'Import Mistake' })).toBeChecked();
      expect(screen.getByText('Import 2, skip 0, add 0 to exceptions')).toBeInTheDocument();
    });

    it('lets several be picked at once, and the header box picks all of the tab', async () => {
      mockRemoveExceptions.mockResolvedValue({ removed: 2 });
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(tab('Exceptions (2)'));
      const header = screen.getByRole('checkbox', {
        name: 'Select all exceptions in this list',
      }) as HTMLInputElement;

      fireEvent.click(exceptionBox('Mistake'));
      expect(header.indeterminate).toBe(true);
      fireEvent.click(header);
      expect(exceptionBox('Mistake')).toBeChecked();
      expect(exceptionBox('Duplicate charge')).toBeChecked();
      expect(removeButton('Remove 2 from exceptions')).toBeEnabled();

      await act(async () => {
        fireEvent.click(removeButton('Remove 2 from exceptions'));
      });
      expect(mockRemoveExceptions).toHaveBeenCalledWith('ba-1', ['ref:x1', 'ref:x2']);
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith('2 transactions were removed from the exceptions'),
      );
    });

    it('says when nothing was removed, and still reads the preview again', async () => {
      mockRemoveExceptions.mockResolvedValue({ removed: 0 });
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(tab('Exceptions (2)'));
      fireEvent.click(exceptionBox('Mistake'));
      await act(async () => {
        fireEvent.click(removeButton('Remove 1 from exceptions'));
      });
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith('Nothing was removed from the exceptions'),
      );
      expect(mockPreviewAccount).toHaveBeenCalledTimes(2);
    });

    it('keeps the exceptions on screen and says why when removing fails', async () => {
      mockRemoveExceptions.mockRejectedValue(axiosFailure(404, 'Bank account not found'));
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(tab('Exceptions (2)'));
      fireEvent.click(exceptionBox('Mistake'));
      await act(async () => {
        fireEvent.click(removeButton('Remove 1 from exceptions'));
      });
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Bank account not found'));
      expect(mockPreviewAccount).toHaveBeenCalledTimes(1);
      expect(exceptionBox('Mistake')).toBeChecked();
    });

    it('falls back to its own words when the failure carries none', async () => {
      mockRemoveExceptions.mockRejectedValue(axiosFailure(500, ''));
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(tab('Exceptions (2)'));
      fireEvent.click(exceptionBox('Mistake'));
      await act(async () => {
        fireEvent.click(removeButton('Remove 1 from exceptions'));
      });
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not remove the exceptions'));
    });

    it('is empty without exceptions: no remove button', async () => {
      mockPreviewAccount.mockResolvedValue(preview());
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(tab('Exceptions (0)'));
      expect(screen.getByText('No transactions in this list.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Remove .* from exceptions/ })).not.toBeInTheDocument();
    });

    it('offers the picking on a phone too', async () => {
      setPhoneViewport(true);
      mockRemoveExceptions.mockResolvedValue({ removed: 1 });
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(tab('Exceptions (2)'));
      expect(within(screen.getByRole('tabpanel')).getAllByRole('listitem')).toHaveLength(2);
      fireEvent.click(exceptionBox('Duplicate charge'));
      await act(async () => {
        fireEvent.click(removeButton('Remove 1 from exceptions'));
      });
      expect(mockRemoveExceptions).toHaveBeenCalledWith('ba-1', ['ref:x2']);
    });
  });

  describe('the payee (spec section 7b)', () => {
    const payee = (over: Partial<NonNullable<BankSyncPreviewRow['payee']>>) => ({
      original: 'BIEDRONKA 4711',
      name: 'Biedronka S.A.',
      via: 'alias' as const,
      aliasPattern: 'BIEDRONKA*',
      payeeId: 'p-1',
      ...over,
    });
    const withPayee = (info: BankSyncPreviewRow['payee'], over: Partial<BankSyncPreviewRow> = {}) => {
      mockPreviewAccount.mockResolvedValue(
        preview({
          rows: [
            row({
              externalKey: 'ref:p',
              payeeText: 'BIEDRONKA 4711',
              payeeName: info?.name ?? null,
              payee: info,
              ...over,
            }),
          ],
          summary: { new: 1, duplicate: 0, excluded: 0, refused: 0, refusedByReason: {}, pending: 0, beforeCutoff: 0 },
        }),
      );
    };

    it('shows the mapped name, with how it was found beside it for an alias', async () => {
      withPayee(payee({}));
      await loaded();
      await screen.findByText('Monize balance now');
      const only = bodyRows()[0];
      expect(within(only).getByText('Biedronka S.A.')).toBeInTheDocument();
      expect(
        within(only).getByRole('button', {
          name: 'From the bank: BIEDRONKA 4711. Maps to: Biedronka S.A. (alias "BIEDRONKA*")',
        }),
      ).toBeInTheDocument();
    });

    it('says a payee is new, or set by a rule', async () => {
      withPayee(payee({ via: 'new', aliasPattern: null, payeeId: null, name: 'BIEDRONKA 4711' }));
      await loaded();
      await screen.findByText('Monize balance now');
      expect(
        within(bodyRows()[0]).getByRole('button', {
          name: 'From the bank: BIEDRONKA 4711. Maps to: BIEDRONKA 4711 (new payee)',
        }),
      ).toBeInTheDocument();
    });

    it('says a payee was set by a rule, and when a rule clears it', async () => {
      withPayee(payee({ via: 'rule', aliasPattern: null }));
      const first = await loaded();
      await screen.findByText('Monize balance now');
      expect(
        within(bodyRows()[0]).getByRole('button', {
          name: 'From the bank: BIEDRONKA 4711. Maps to: Biedronka S.A. (set by a rule)',
        }),
      ).toBeInTheDocument();
      first.unmount();

      withPayee(payee({ via: 'rule', name: null, aliasPattern: null, payeeId: null }), { payeeName: null });
      await loaded();
      await screen.findByText('Monize balance now');
      expect(
        within(bodyRows()[0]).getByRole('button', {
          name: 'From the bank: BIEDRONKA 4711. Maps to: no payee (set by a rule)',
        }),
      ).toBeInTheDocument();
    });

    it('does not explain a payee that is the bank\'s own text', async () => {
      withPayee(payee({ via: 'name', original: 'Biedronka S.A.', name: 'Biedronka S.A.' }));
      await loaded();
      await screen.findByText('Monize balance now');
      expect(within(bodyRows()[0]).queryByRole('button', { name: /From the bank/ })).not.toBeInTheDocument();
    });

    it('does not explain a row with no payee at all', async () => {
      withPayee(payee({ via: 'none', name: null, original: null, aliasPattern: null, payeeId: null }));
      await loaded();
      await screen.findByText('Monize balance now');
      expect(within(bodyRows()[0]).queryByRole('button', { name: /From the bank/ })).not.toBeInTheDocument();
    });

    it('explains the payee on a phone card too', async () => {
      setPhoneViewport(true);
      withPayee(payee({}));
      await loaded();
      await screen.findByText('Monize balance now');
      expect(
        within(within(screen.getByRole('tabpanel')).getAllByRole('listitem')[0]).getByRole('button', {
          name: /From the bank: BIEDRONKA 4711\. Maps to: Biedronka S\.A\. \(alias/,
        }),
      ).toBeInTheDocument();
    });
  });

  describe('the details of a row (spec section 7b)', () => {
    const DETAILED = () =>
      row({
        externalKey: 'ref:z',
        payeeText: 'BIEDRONKA 4711',
        payeeName: 'Biedronka S.A.',
        categoryName: 'Food',
        tagNames: ['Card payment'],
        operationTag: 'Card payment',
        payee: {
          original: 'BIEDRONKA 4711',
          name: 'Biedronka S.A.',
          via: 'alias',
          aliasPattern: 'BIEDRONKA*',
          payeeId: 'p-1',
        },
        rules: [
          {
            ruleId: 'r-1',
            ruleName: 'Food rule',
            changes: {
              categoryId: { before: null, after: 'cat-9' },
              tagIds: { before: [], after: ['tag-1'] },
            },
            applied: [{ type: 'set_category' }, { type: 'add_tags' }],
            skipped: [{ type: 'set_payee_from_text', reason: 'payee_not_found' }],
            stopped: true,
          },
        ],
      });
    const withDetailed = (extra: BankSyncPreviewRow[] = []) =>
      mockPreviewAccount.mockResolvedValue(
        preview({
          rows: [DETAILED(), ...extra],
          labels: {
            categories: { 'cat-9': 'Food' },
            payees: {},
            tags: { 'tag-1': 'Weekly' },
          },
          summary: { new: 1, duplicate: 0, excluded: 0, refused: 0, refusedByReason: {}, pending: 0, beforeCutoff: 0 },
        }),
      );
    const toggle = (name: string | RegExp = /Show details of/) => screen.getByRole('button', { name });

    it('opens and closes from a button that says whether it is open, and points at the details only while they are in the page', async () => {
      withDetailed();
      await loaded();
      await screen.findByText('Monize balance now');

      const button = toggle('Show details of Biedronka S.A.');
      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(button).not.toHaveAttribute('aria-controls');
      expect(screen.queryByText('Import rules')).not.toBeInTheDocument();

      fireEvent.click(button);

      const open = toggle('Hide details of Biedronka S.A.');
      expect(open).toHaveAttribute('aria-expanded', 'true');
      const controlled = open.getAttribute('aria-controls') as string;
      expect(document.getElementById(controlled)).toHaveTextContent('Import rules');

      fireEvent.click(open);
      expect(screen.queryByText('Import rules')).not.toBeInTheDocument();
      expect(toggle('Show details of Biedronka S.A.')).not.toHaveAttribute('aria-controls');
    });

    it('lists each matching rule by name, linked to the rule, with what it changed in words and what it skipped', async () => {
      withDetailed();
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(toggle());

      const link = screen.getByRole('link', { name: 'Open the rule Food rule in a new tab' });
      expect(link).toHaveAttribute('href', '/rules/r-1');
      // The preview is a pushHistory modal: following an in-app link in this
      // tab would pop its history entry and land back on the settings page.
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(screen.getByText('Category: none → Food')).toBeInTheDocument();
      expect(screen.getByText('Tags added: Weekly')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Set the payee from text: skipped (no payee has the name the rule built, and it does not create one)',
        ),
      ).toBeInTheDocument();
      expect(screen.getByText('Stops the rules after it.')).toBeInTheDocument();
    });

    it('says when no rule matched', async () => {
      mockPreviewAccount.mockResolvedValue(
        preview({
          rows: [row({ externalKey: 'ref:q', rules: [] })],
          summary: { new: 1, duplicate: 0, excluded: 0, refused: 0, refusedByReason: {}, pending: 0, beforeCutoff: 0 },
        }),
      );
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(toggle());
      expect(screen.getByText('No import rule matched this transaction.')).toBeInTheDocument();
    });

    it('names a rule it has no name for generically, never by its id', async () => {
      mockPreviewAccount.mockResolvedValue(
        preview({
          rows: [
            row({
              externalKey: 'ref:q',
              rules: [
                {
                  ruleId: 'r-secret-id',
                  ruleName: null,
                  changes: {},
                  applied: [{ type: 'request_ai_review' }],
                  skipped: [],
                  stopped: false,
                },
              ],
            }),
          ],
          summary: { new: 1, duplicate: 0, excluded: 0, refused: 0, refusedByReason: {}, pending: 0, beforeCutoff: 0 },
        }),
      );
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(toggle());
      expect(screen.getByRole('link', { name: 'Open the rule Rule in a new tab' })).toHaveAttribute(
        'href',
        '/rules/r-secret-id',
      );
      expect(screen.getByText('Applied: Ask for an AI review')).toBeInTheDocument();
      expect(screen.queryByText('r-secret-id')).not.toBeInTheDocument();
    });

    it('explains how the payee was found and links to its aliases when the payee exists', async () => {
      withDetailed();
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(toggle());

      expect(screen.getByText("The bank's text: BIEDRONKA 4711")).toBeInTheDocument();
      expect(
        screen.getByText('Maps to Biedronka S.A. through the alias "BIEDRONKA*".'),
      ).toBeInTheDocument();
      const aliases = screen.getByRole('link', { name: "Open the payee's aliases in a new tab" });
      expect(aliases).toHaveAttribute('href', '/payees/p-1?tab=aliases');
      expect(aliases).toHaveAttribute('target', '_blank');
      expect(aliases).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('offers no aliases link for a payee that does not exist yet', async () => {
      mockPreviewAccount.mockResolvedValue(
        preview({
          rows: [
            row({
              externalKey: 'ref:q',
              payee: { original: 'Brand new', name: 'Brand new', via: 'new', aliasPattern: null, payeeId: null },
            }),
          ],
          summary: { new: 1, duplicate: 0, excluded: 0, refused: 0, refusedByReason: {}, pending: 0, beforeCutoff: 0 },
        }),
      );
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(toggle());
      expect(screen.getByText('No payee has this name yet, so Brand new would be created.')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /aliases/ })).not.toBeInTheDocument();
    });

    it('shows the operation type tag, or says there is none', async () => {
      withDetailed();
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(toggle());
      expect(screen.getByText("Tag from the bank's operation type: Card payment")).toBeInTheDocument();
    });

    it('says there is no operation type tag when there is none', async () => {
      mockPreviewAccount.mockResolvedValue(
        preview({
          rows: [row({ externalKey: 'ref:q', operationTag: null })],
          summary: { new: 1, duplicate: 0, excluded: 0, refused: 0, refusedByReason: {}, pending: 0, beforeCutoff: 0 },
        }),
      );
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(toggle());
      expect(screen.getByText('No operation type tag for this transaction.')).toBeInTheDocument();
    });

    it('does not offer details for a row that is not new', async () => {
      withDetailed([row({ outcome: 'duplicate', externalKey: 'ref:d', payeeText: 'Done', payeeName: null })]);
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(tab('All (2)'));
      expect(screen.getAllByRole('button', { name: /details of/ })).toHaveLength(1);
    });

    it('opens inside the row card on a phone', async () => {
      setPhoneViewport(true);
      withDetailed();
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(toggle());
      const card = within(screen.getByRole('tabpanel')).getAllByRole('listitem')[0];
      expect(within(card).getByRole('link', { name: 'Open the rule Food rule in a new tab' })).toBeInTheDocument();
      expect(within(card).getByText('Import rules')).toBeInTheDocument();
    });

    it('keeps each row\'s details apart', async () => {
      withDetailed([
        row({ externalKey: 'ref:y', payeeText: 'Other', payeeName: 'Other', payee: null, rules: [] }),
      ]);
      await loaded();
      await screen.findByText('Monize balance now');
      fireEvent.click(toggle('Show details of Biedronka S.A.'));
      expect(screen.getAllByText('Import rules')).toHaveLength(1);
      expect(toggle('Show details of Other')).toHaveAttribute('aria-expanded', 'false');
    });
  });
});
