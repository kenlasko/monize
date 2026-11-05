import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act } from '@/test/render';
import { SplitEditor, SplitRow, toCreateSplitData, toSplitRows } from './SplitEditor';
import { receivedAmountToSend } from './split-transfer-currency';
import type { Account } from '@/types/account';

const mockGetRateForDate = vi.fn();
vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getRateForDate: (...args: unknown[]) => mockGetRateForDate(...args),
  },
}));

// jsdom does not implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

const accounts = [
  { id: 'cad-chq', name: 'Chequing', isClosed: false, accountSubType: null, currencyCode: 'CAD' },
  { id: 'cad-sav', name: 'Savings', isClosed: false, accountSubType: null, currencyCode: 'CAD' },
  { id: 'usd-sav', name: 'US Savings', isClosed: false, accountSubType: null, currencyCode: 'USD' },
  { id: 'eur-sav', name: 'Euro Savings', isClosed: false, accountSubType: null, currencyCode: 'EUR' },
] as unknown as Account[];

const categories = [
  { id: 'cat-1', name: 'Groceries', parentId: null, isIncome: false },
] as never[];

function line(overrides: Partial<SplitRow>): SplitRow {
  return {
    id: 'line',
    splitType: 'category',
    categoryId: undefined,
    transferAccountId: undefined,
    amount: 0,
    memo: '',
    ...overrides,
  };
}

const onChangeSpy = vi.fn();

/** The editor over real state, as the transaction form holds its splits. */
function Harness({
  initial,
  crossCurrencyTransfers = true,
}: {
  initial: SplitRow[];
  crossCurrencyTransfers?: boolean;
}) {
  const [splits, setSplits] = useState(initial);
  return (
    <SplitEditor
      splits={splits}
      onChange={(next) => {
        onChangeSpy(next);
        setSplits(next);
      }}
      categories={categories}
      accounts={accounts}
      sourceAccountId="cad-chq"
      transactionAmount={-100}
      currencyCode="CAD"
      transactionDate="2026-10-29"
      crossCurrencyTransfers={crossCurrencyTransfers}
    />
  );
}

const lastSplits = (): SplitRow[] => onChangeSpy.mock.calls.at(-1)?.[0];

async function flushRate() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(350);
  });
}

/** A parent whose account currency the test can move away and back. */
  const initial = [
    line({ id: 'a', categoryId: 'cat-1', amount: -60 }),
    line({
      id: 'b',
      splitType: 'transfer',
      transferAccountId: 'usd-sav',
      amount: -40,
      transferTargetAmount: 28.75,
      transferTargetFromCurrency: 'CAD',
    }),
  ];
  function MovingParent() {
    const [splits, setSplits] = useState(initial);
    const [currency, setCurrency] = useState('CAD');
    return (
      <>
        <button type="button" onClick={() => setCurrency('EUR')}>
          move
        </button>
        <button type="button" onClick={() => setCurrency('CAD')}>
          back
        </button>
        <SplitEditor
          splits={splits}
          onChange={(next) => {
            onChangeSpy(next);
            setSplits(next);
          }}
          categories={categories}
          accounts={accounts}
          sourceAccountId="cad-chq"
          transactionAmount={-100}
          currencyCode={currency}
          transactionDate="2026-10-29"
          crossCurrencyTransfers
        />
      </>
    );
  }

describe('SplitEditor -- cross-currency transfer lines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    onChangeSpy.mockReset();
    mockGetRateForDate.mockReset();
    mockGetRateForDate.mockResolvedValue(0.73);
  });

  const usdTransfer = () => [
    line({ id: 'a', categoryId: 'cat-1', amount: -60 }),
    line({ id: 'b', splitType: 'transfer', transferAccountId: 'usd-sav', amount: -40 }),
  ];

  it('labels the line with both currencies and fills the received amount from the day rate', async () => {
    await act(async () => {
      render(<Harness initial={usdTransfer()} />);
    });
    await flushRate();

    // Mobile card and desktop row each carry the pair.
    expect(screen.getAllByText('Transfer Amount (CAD)')).toHaveLength(2);
    expect(screen.getAllByText('Amount Received (USD)')).toHaveLength(2);
    expect(mockGetRateForDate).toHaveBeenCalledWith('CAD', 'USD', '2026-10-29');
    expect(lastSplits()[1].transferTargetAmount).toBe(29.2);
    expect(lastSplits()[1].amount).toBe(-40);
  });

  it('shows no received amount for a same-currency transfer line', async () => {
    await act(async () => {
      render(
        <Harness
          initial={[
            line({ id: 'a', categoryId: 'cat-1', amount: -60 }),
            line({ id: 'b', splitType: 'transfer', transferAccountId: 'cad-sav', amount: -40 }),
          ]}
        />,
      );
    });
    await flushRate();

    expect(screen.queryByText('Transfer Amount (CAD)')).not.toBeInTheDocument();
    expect(screen.queryByText(/Amount Received/)).not.toBeInTheDocument();
    expect(mockGetRateForDate).not.toHaveBeenCalled();
  });

  it('shows no received amount on a surface that does not offer it', async () => {
    await act(async () => {
      render(<Harness initial={usdTransfer()} crossCurrencyTransfers={false} />);
    });
    await flushRate();

    expect(screen.queryByText(/Amount Received/)).not.toBeInTheDocument();
    expect(mockGetRateForDate).not.toHaveBeenCalled();
  });

  it('keeps a typed received amount and leaves the transfer amount alone', async () => {
    await act(async () => {
      render(<Harness initial={usdTransfer()} />);
    });
    await flushRate();

    const received = screen.getAllByLabelText('Amount Received (USD)')[0];
    fireEvent.change(received, { target: { value: '28.75' } });
    fireEvent.blur(received);

    expect(lastSplits()[1].transferTargetAmount).toBe(28.75);
    expect(lastSplits()[1].amount).toBe(-40);
  });

  it('starts a new target account empty and fills it from that pair', async () => {
    await act(async () => {
      render(<Harness initial={usdTransfer()} />);
    });
    await flushRate();
    expect(lastSplits()[1].transferTargetAmount).toBe(29.2);

    mockGetRateForDate.mockResolvedValue(0.65);
    const accountSelect = screen.getAllByDisplayValue('US Savings')[0];
    fireEvent.change(accountSelect, { target: { value: 'eur-sav' } });
    expect(lastSplits()[1].transferTargetAmount).toBeUndefined();

    await flushRate();
    expect(mockGetRateForDate).toHaveBeenLastCalledWith('CAD', 'EUR', '2026-10-29');
    expect(lastSplits()[1].transferTargetAmount).toBe(26);
    expect(screen.getAllByText('Amount Received (EUR)')).toHaveLength(2);
  });

  it('re-derives a typed received amount once the parent currency changes', async () => {
    await act(async () => {
      render(<MovingParent />);
    });
    await flushRate();
    // The edited figure is kept for its own pair.
    expect(screen.getAllByDisplayValue('28.75').length).toBeGreaterThan(0);

    mockGetRateForDate.mockResolvedValue(1.08);
    fireEvent.click(screen.getByRole('button', { name: 'move' }));
    // Stale for the new pair: no longer shown.
    expect(screen.queryAllByDisplayValue('28.75')).toHaveLength(0);

    await flushRate();
    expect(mockGetRateForDate).toHaveBeenLastCalledWith('EUR', 'USD', '2026-10-29');
    expect(lastSplits()[1].transferTargetAmount).toBe(43.2);
    expect(lastSplits()[1].transferTargetFromCurrency).toBe('EUR');

    // Back to the CAD account: the bank's figure returns, not a re-derived one.
    mockGetRateForDate.mockResolvedValue(0.73);
    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    await flushRate();
    expect(lastSplits()[1].transferTargetAmount).toBe(28.75);
    expect(lastSplits()[1].transferTargetFromCurrency).toBe('CAD');
  });

  it('brings a stated figure back even when no rate arrives on the way back', async () => {
    await act(async () => {
      render(<MovingParent />);
    });
    await flushRate();
    mockGetRateForDate.mockResolvedValue(1.08);
    fireEvent.click(screen.getByRole('button', { name: 'move' }));
    await flushRate();
    expect(lastSplits()[1].transferTargetAmount).toBe(43.2);

    // The CAD rate is unavailable now; the bank's figure needs none.
    mockGetRateForDate.mockResolvedValue(null);
    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    await flushRate();
    expect(lastSplits()[1].transferTargetAmount).toBe(28.75);
    expect(lastSplits()[1].transferTargetFromCurrency).toBe('CAD');
  });

  it('does not restore a stated figure onto another destination account', async () => {
    // The bank credited 28.75 USD; the line is then pointed at the EUR account.
    await act(async () => {
      render(
        <Harness
          initial={[
            line({ id: 'a', categoryId: 'cat-1', amount: -60 }),
            line({
              id: 'b',
              splitType: 'transfer',
              transferAccountId: 'usd-sav',
              amount: -40,
              transferTargetAmount: 28.75,
              transferTargetFromCurrency: 'CAD',
            }),
          ]}
        />,
      );
    });
    await flushRate();

    mockGetRateForDate.mockResolvedValue(0.65);
    fireEvent.change(screen.getAllByDisplayValue('US Savings')[0], {
      target: { value: 'eur-sav' },
    });
    await flushRate();
    // 40 CAD at 0.65, not the USD figure relabelled as euros.
    expect(lastSplits()[1].transferTargetAmount).toBe(26);

    // Back to the USD account it was stated for: the bank's figure returns.
    mockGetRateForDate.mockResolvedValue(0.73);
    fireEvent.change(screen.getAllByDisplayValue('Euro Savings')[0], {
      target: { value: 'usd-sav' },
    });
    await flushRate();
    expect(lastSplits()[1].transferTargetAmount).toBe(28.75);
  });

  it('drops the received amount when the line stops being a transfer', async () => {
    await act(async () => {
      render(<Harness initial={usdTransfer()} />);
    });
    await flushRate();

    const typeSelect = screen.getAllByDisplayValue('Transfer')[0];
    fireEvent.change(typeSelect, { target: { value: 'category' } });

    expect(lastSplits()[1].splitType).toBe('category');
    expect(lastSplits()[1].transferTargetAmount).toBeUndefined();
  });

  it('re-derives a filled received amount when distributing moves the line amount', async () => {
    await act(async () => {
      render(<Harness initial={usdTransfer()} />);
    });
    await flushRate();

    fireEvent.click(screen.getByRole('button', { name: 'Distribute Evenly' }));

    expect(lastSplits()[1].amount).toBe(-50);
    expect(lastSplits()[1].transferTargetAmount).toBe(36.5);
  });
});

describe('toSplitRows -- received amount', () => {
  const counterpartLine = {
    id: 'b',
    transferAccountId: 'usd-sav',
    amount: -40,
    linkedTransaction: { amount: 29.1234 },
  };

  it('loads an edited row received amount from its counterpart, unsigned and tagged', () => {
    const [row] = toSplitRows([counterpartLine], { receivedAmountsIn: 'CAD' });
    expect(row.transferTargetAmount).toBe(29.1234);
    expect(row.transferTargetFromCurrency).toBe('CAD');
  });

  it('loads none for a duplicate or quick fill, which name no currency', () => {
    const [row] = toSplitRows([counterpartLine]);
    expect(row.transferTargetAmount).toBeUndefined();
  });

  it('leaves it unset without a counterpart or on a category line', () => {
    const rows = toSplitRows(
      [
        { id: 'a', transferAccountId: 'usd-sav', amount: -40 },
        { id: 'b', categoryId: 'cat-1', amount: -40, linkedTransaction: { amount: 40 } },
      ],
      { receivedAmountsIn: 'CAD' },
    );
    expect(rows[0].transferTargetAmount).toBeUndefined();
    expect(rows[1].transferTargetAmount).toBeUndefined();
  });
});

describe('toCreateSplitData -- received amount', () => {
  const tagged = { transferTargetFromCurrency: 'CAD' };
  const rows: SplitRow[] = [
    line({ id: 'a', categoryId: 'cat-1', amount: -60, transferTargetAmount: 5, ...tagged }),
    line({ id: 'b', splitType: 'transfer', transferAccountId: 'usd-sav', amount: -40, transferTargetAmount: 29.2, ...tagged }),
    line({ id: 'c', splitType: 'transfer', transferAccountId: 'cad-sav', amount: -40, transferTargetAmount: 40, ...tagged }),
    // Stated against another parent currency: stale, so not sent.
    line({ id: 'd', splitType: 'transfer', transferAccountId: 'eur-sav', amount: -40, transferTargetAmount: 26, transferTargetFromCurrency: 'GBP' }),
  ];

  it('sends it only for cross-currency transfer lines stated against the current currency', () => {
    const data = toCreateSplitData(rows, {
      transferTargetAmountOf: (split) => receivedAmountToSend(split, accounts, 'CAD'),
    });
    expect(data.map((d) => d.transferTargetAmount)).toEqual([undefined, 29.2, undefined, undefined]);
  });

  it('sends none when the caller names no lines', () => {
    expect(toCreateSplitData(rows).every((d) => d.transferTargetAmount === undefined)).toBe(true);
  });
});
