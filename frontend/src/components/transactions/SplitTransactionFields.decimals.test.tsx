import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { SplitTransactionFields } from './SplitTransactionFields';
import { clearCurrencyDecimals, registerCurrencyDecimals } from '@/lib/currency-decimals';
import type { Account } from '@/types/account';
import type { Payee } from '@/types/payee';

/**
 * The split form's Total Amount through the real `CurrencyInput`, so the
 * precision it is given is the precision it parses and displays at. The
 * sibling suite mocks the input and cannot see the `decimalPlaces` prop.
 */
function Harness({
  currencyCode,
  initial,
  onAmount,
}: {
  currencyCode: string;
  initial: number;
  onAmount: (value: number | undefined) => void;
}) {
  const [amount, setAmount] = useState(initial);
  return (
    <SplitTransactionFields
      register={vi.fn().mockReturnValue({ name: 'field', onChange: vi.fn(), onBlur: vi.fn(), ref: vi.fn() })}
      setValue={vi.fn()}
      errors={{}}
      watchedAccountId=""
      watchedAmount={amount}
      watchedCurrencyCode={currencyCode}
      accounts={[] as Account[]}
      selectedPayeeId=""
      payees={[] as Payee[]}
      handlePayeeChange={vi.fn()}
      handlePayeeCreate={vi.fn()}
      handleAmountChange={(value) => {
        onAmount(value);
        setAmount(value ?? 0);
      }}
    />
  );
}

describe('SplitTransactionFields Total Amount precision', () => {
  afterEach(() => {
    // The mounted input subscribes to the registry, so emptying it re-renders.
    act(() => clearCurrencyDecimals());
  });

  it('round-trips an eight-place coin total typed as -0.00502500', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    const onAmount = vi.fn();
    render(<Harness currencyCode="BTC" initial={0} onAmount={onAmount} />);
    const input = screen.getByLabelText('Total Amount');
    fireEvent.change(input, { target: { value: '-0.00502500' } });
    fireEvent.blur(input);
    // At the input's default two places this was -0.01, at four -0.0050.
    expect(onAmount).toHaveBeenLastCalledWith(-0.005025);
    expect(input).toHaveValue('-0.00502500');
  });

  it('enters a coin total at the column scale before the registry has loaded', () => {
    const onAmount = vi.fn();
    render(<Harness currencyCode="BTC" initial={0} onAmount={onAmount} />);
    const input = screen.getByLabelText('Total Amount');
    fireEvent.change(input, { target: { value: '0.01249993' } });
    fireEvent.blur(input);
    // At the input's default two places this was 0.01.
    expect(onAmount).toHaveBeenLastCalledWith(0.01249993);
  });

  it('renders a stored coin total at its eight places', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    render(<Harness currencyCode="BTC" initial={-0.005025} onAmount={vi.fn()} />);
    expect(screen.getByLabelText('Total Amount')).toHaveValue('-0.00502500');
  });

  it('keeps an ISO currency total at two places', () => {
    const onAmount = vi.fn();
    render(<Harness currencyCode="CAD" initial={0} onAmount={onAmount} />);
    const input = screen.getByLabelText('Total Amount');
    fireEvent.change(input, { target: { value: '-12.345' } });
    fireEvent.blur(input);
    expect(onAmount).toHaveBeenLastCalledWith(-12.35);
    expect(input).toHaveValue('-12.35');
  });

  it('prefixes a registered coin total with its stored symbol, not its code', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8, symbol: '\u20bf' }]);
    const { container } = render(<Harness currencyCode="BTC" initial={-0.005025} onAmount={vi.fn()} />);
    expect(screen.getByText('\u20bf')).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/BTC/);
  });

  it('keeps the code as the prefix of an unregistered coin', () => {
    render(<Harness currencyCode="BTC" initial={0} onAmount={vi.fn()} />);
    expect(screen.getByText('BTC')).toBeInTheDocument();
  });

  it('keeps an ISO currency\'s Intl symbol as the prefix', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8, symbol: '\u20bf' }]);
    render(<Harness currencyCode="EUR" initial={0} onAmount={vi.fn()} />);
    expect(screen.getByText('\u20ac')).toBeInTheDocument();
  });
});
