import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { QuoteTableUrlField } from './QuoteTableUrlField';
import { buildSecuritySchema, valuesToValidate, type SecurityFormData } from './securityFormModel';

vi.mock('@/lib/investments', () => ({
  investmentsApi: { previewQuoteTable: vi.fn() },
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatNumber: (n: number, d = 2) => n.toFixed(d),
    }),
  };
});

const { investmentsApi } = await import('@/lib/investments');
const previewMock = vi.mocked(investmentsApi.previewQuoteTable);

const registration = {
  name: 'quoteUrl' as const,
  onChange: vi.fn(),
  onBlur: vi.fn(),
  ref: vi.fn(),
};

describe('QuoteTableUrlField', () => {
  beforeEach(() => previewMock.mockReset());

  it('cannot test an empty address', () => {
    render(<QuoteTableUrlField registration={registration} url="  " />);
    expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled();
  });

  it('shows what the page yielded, newest row first', async () => {
    previewMock.mockResolvedValueOnce({
      columns: { date: 'Datum', close: 'Schluss', volume: 'Stücke' },
      currencyCode: 'EUR',
      totalRows: 23,
      skippedRows: 2,
      firstDate: '2026-10-01',
      lastDate: '2026-11-02',
      rows: [
        { date: '2026-11-02', open: 3623.81, high: 3635.17, low: 3604.05, close: 3609.23, volume: null },
        { date: '2026-10-30', open: null, high: null, low: null, close: 3604.63, volume: 1200 },
      ],
    });
    render(
      <QuoteTableUrlField registration={registration} url=" https://www.ariva.de/k " />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    });

    expect(previewMock).toHaveBeenCalledWith('https://www.ariva.de/k');
    expect(screen.getByText('23 days from 2026-10-01 to 2026-11-02')).toBeInTheDocument();
    expect(screen.getByText('Columns used: Datum, Schluss, Stücke')).toBeInTheDocument();
    expect(screen.getByText('Currency shown on the page: EUR')).toBeInTheDocument();
    expect(
      screen.getByText('2 rows could not be read and were skipped'),
    ).toBeInTheDocument();
    const rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('2026-11-02');
    expect(rows[1]).toHaveTextContent('3609.23');
    // An unknown value reads as unknown, not as zero.
    expect(rows[2]).toHaveTextContent('-');
    expect(rows[2]).toHaveTextContent('1200');
  });

  it('says when the page names no currency', async () => {
    previewMock.mockResolvedValueOnce({
      columns: { date: 'Date', close: 'Close' },
      currencyCode: null,
      totalRows: 1,
      skippedRows: 0,
      firstDate: '2026-11-02',
      lastDate: '2026-11-02',
      rows: [{ date: '2026-11-02', open: null, high: null, low: null, close: 95.69, volume: null }],
    });
    render(<QuoteTableUrlField registration={registration} url="https://markets.ft.com/x" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    });
    expect(
      screen.getByText("The page shows no currency; prices are stored in the security's currency."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument();
  });

  it("shows the server's reason when the page cannot be read", async () => {
    previewMock.mockRejectedValueOnce({
      response: { data: { message: 'No price table was found on the page.' } },
    });
    render(<QuoteTableUrlField registration={registration} url="https://example.com/x" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('No price table was found on the page.');
    expect(screen.queryByTestId('quote-table-preview')).not.toBeInTheDocument();
  });
});

describe('security form schema: web page table', () => {
  const schema = buildSecuritySchema((key) => key);
  const base = { symbol: 'KRUG', name: 'Krugerrand', currencyCode: 'EUR' };

  it('needs a page address when the provider reads one', () => {
    const result = schema.safeParse({ ...base, quoteProvider: 'html_table', quoteUrl: ' ' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['quoteUrl'],
      message: 'validation.quoteUrlRequired',
    });
  });

  it('needs a full http or https address', () => {
    const result = schema.safeParse({
      ...base,
      quoteProvider: 'html_table',
      quoteUrl: 'www.ariva.de/k',
    });
    expect(result.error?.issues[0].message).toBe('validation.quoteUrlInvalid');
  });

  it('accepts a page address, and ignores the field for other providers', () => {
    expect(
      schema.safeParse({
        ...base,
        quoteProvider: 'html_table',
        quoteUrl: 'https://www.ariva.de/k?x=1',
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ ...base, quoteProvider: 'yahoo', quoteUrl: '' }).success).toBe(
      true,
    );
  });
});

describe('a preview belongs to the address it was asked for', () => {
  beforeEach(() => previewMock.mockReset());

  const answer = (totalRows: number) => ({
    columns: { date: 'Date', close: 'Close' },
    currencyCode: null,
    totalRows,
    skippedRows: 0,
    firstDate: '2026-10-01',
    lastDate: '2026-11-02',
    rows: [],
  });

  it('hides the answer once the address is edited', async () => {
    previewMock.mockResolvedValueOnce(answer(120));
    const { rerender } = render(
      <QuoteTableUrlField registration={registration} url="https://a.example/p" />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    });
    expect(screen.getByTestId('quote-table-preview')).toBeInTheDocument();

    rerender(<QuoteTableUrlField registration={registration} url="https://b.example/p" />);
    expect(screen.queryByTestId('quote-table-preview')).not.toBeInTheDocument();
  });

  it('never shows an answer that arrives after the address changed', async () => {
    let release!: (value: ReturnType<typeof answer>) => void;
    previewMock.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { rerender } = render(
      <QuoteTableUrlField registration={registration} url="https://a.example/p" />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    });
    rerender(<QuoteTableUrlField registration={registration} url="https://b.example/p" />);
    await act(async () => {
      release(answer(120));
    });

    expect(screen.queryByTestId('quote-table-preview')).not.toBeInTheDocument();
    // The new address can be tested at once: the old request does not hold it.
    expect(screen.getByRole('button', { name: 'Test' })).not.toBeDisabled();
  });
});

describe('valuesToValidate', () => {
  const schema = buildSecuritySchema((key) => key);
  const listedBond = {
    symbol: 'EDO',
    name: 'EDO',
    currencyCode: 'PLN',
    securityType: 'BOND',
    quoteProvider: 'html_table',
    quoteUrl: '',
  } as SecurityFormData;

  it('does not require a page address the form does not show', () => {
    expect(schema.safeParse(valuesToValidate(listedBond, false)).success).toBe(true);
  });

  it('still requires it while the field is shown', () => {
    expect(schema.safeParse(valuesToValidate(listedBond, true)).success).toBe(false);
  });
});
