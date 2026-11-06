import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { SplitAmountFields } from './SplitAmountFields';
import { clearCurrencyDecimals, registerCurrencyDecimals } from '@/lib/currency-decimals';

/** A cross-currency transfer line's received amount, through the real `CurrencyInput`. */
function renderReceived(toCurrency: string, onReceivedChange = vi.fn()) {
  render(
    <SplitAmountFields
      pair={{ toCurrency, fxFeePercent: null }}
      amountCurrencyCode="CAD"
      amountSymbol="$"
      amountDecimals={2}
      amountValue={-100}
      onAmountChange={vi.fn()}
      receivedValue={undefined}
      onReceivedChange={onReceivedChange}
      disabled={false}
    />,
  );
  return { input: screen.getByLabelText(`Amount Received (${toCurrency})`), onReceivedChange };
}

function type(input: HTMLElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

describe('SplitAmountFields received amount precision', () => {
  afterEach(() => {
    act(() => clearCurrencyDecimals());
  });

  it('enters a coin at the column scale before the registry has loaded', () => {
    const { input, onReceivedChange } = renderReceived('BTC');
    type(input, '0.01249993');
    // At `Intl`'s two places for an unknown code this was 0.01.
    expect(onReceivedChange).toHaveBeenLastCalledWith(0.01249993);
  });

  it('enters a registered eight-place coin at its eight places', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    const { input, onReceivedChange } = renderReceived('BTC');
    type(input, '0.00002500');
    expect(onReceivedChange).toHaveBeenLastCalledWith(0.000025);
  });

  it('enters a registered coin at its own places', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 3 }]);
    const { input, onReceivedChange } = renderReceived('BTC');
    type(input, '0.0125');
    expect(onReceivedChange).toHaveBeenLastCalledWith(0.013);
  });

  it('keeps an ISO currency at its own minor unit', () => {
    const usd = renderReceived('USD');
    type(usd.input, '12.345');
    expect(usd.onReceivedChange).toHaveBeenLastCalledWith(12.35);
  });

  it('keeps a currency without a minor unit at whole units', () => {
    const jpy = renderReceived('JPY');
    type(jpy.input, '1234.5');
    expect(jpy.onReceivedChange).toHaveBeenLastCalledWith(1235);
  });
});
