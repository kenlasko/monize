import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { CurrencyPickerButton } from './CurrencyPickerButton';

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getCurrencies: vi.fn().mockResolvedValue([
      { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$', decimalPlaces: 2, isActive: true },
      { code: 'USD', name: 'US Dollar', symbol: 'US$', decimalPlaces: 2, isActive: true },
      { code: 'EUR', name: 'Euro', symbol: '€', decimalPlaces: 2, isActive: true },
      { code: 'OLD', name: 'Retired', symbol: 'O', decimalPlaces: 2, isActive: false },
    ]),
    createCurrency: vi.fn(),
  },
  CurrencyInfo: {},
  CreateCurrencyData: {},
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

async function renderPicker(props: Partial<React.ComponentProps<typeof CurrencyPickerButton>> = {}) {
  const onChange = vi.fn();
  await act(async () => {
    render(
      <CurrencyPickerButton
        value={props.value ?? ''}
        accountCurrencyCode={props.accountCurrencyCode ?? 'CAD'}
        onChange={props.onChange ?? onChange}
      />,
    );
  });
  return { onChange: props.onChange ?? onChange };
}

describe('CurrencyPickerButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the account currency symbol when no entry currency is set', async () => {
    await renderPicker({ value: '', accountCurrencyCode: 'USD' });
    // Narrow symbol for USD is "$".
    expect(screen.getByRole('button')).toHaveTextContent('$');
  });

  it('opens the popover and lists active currencies (excluding the account currency and inactive ones)', async () => {
    await renderPicker({ accountCurrencyCode: 'CAD' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    await waitFor(() => {
      expect(screen.getByText(/US\$ -- USD US Dollar/)).toBeInTheDocument();
    });
    // Euro is offered; the account currency (CAD) and inactive OLD are not listed as options.
    expect(screen.getByText(/€ -- EUR Euro/)).toBeInTheDocument();
    expect(screen.queryByText(/OLD Retired/)).not.toBeInTheDocument();
  });

  it('calls onChange with the selected currency code', async () => {
    const { onChange } = await renderPicker({ accountCurrencyCode: 'CAD' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    await waitFor(() => screen.getByText(/EUR Euro/));
    await act(async () => {
      fireEvent.click(screen.getByText(/EUR Euro/));
    });
    expect(onChange).toHaveBeenCalledWith('EUR');
  });

  it('calls onChange with an empty string when the account-currency row is chosen', async () => {
    const { onChange } = await renderPicker({ value: 'EUR', accountCurrencyCode: 'CAD' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    await waitFor(() => screen.getByText(/Account currency \(CAD\)/));
    await act(async () => {
      fireEvent.click(screen.getByText(/Account currency \(CAD\)/));
    });
    expect(onChange).toHaveBeenCalledWith('');
  });
});
