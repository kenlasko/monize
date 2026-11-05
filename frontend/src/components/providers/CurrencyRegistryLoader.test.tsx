import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@/test/render';
import { CurrencyRegistryLoader } from './CurrencyRegistryLoader';
import {
  clearCurrencyDecimals,
  decimalPlacesForCurrency,
  registerCurrencyDecimals,
  symbolForCurrency,
} from '@/lib/currency-decimals';

const mockGetCurrencies = vi.fn();
const { mockLoggerError } = vi.hoisted(() => ({ mockLoggerError: vi.fn() }));

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getCurrencies: (...args: unknown[]) => mockGetCurrencies(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: mockLoggerError, info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

let authState = { isAuthenticated: true, _hasHydrated: true };

vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector: (state: typeof authState) => unknown) => selector(authState),
}));

const BTC = {
  code: 'BTC',
  name: 'Bitcoin',
  symbol: 'B',
  decimalPlaces: 4,
  isActive: true,
  isSystem: false,
  createdAt: '2026-11-05T00:00:00Z',
  kind: 'CRYPTO',
  quoteSymbol: 'BTC-CAD',
};

async function renderLoader() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<CurrencyRegistryLoader />);
  });
  return result!;
}

describe('CurrencyRegistryLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCurrencyDecimals();
    authState = { isAuthenticated: true, _hasHydrated: true };
    mockGetCurrencies.mockResolvedValue([BTC]);
  });

  it('loads every currency, inactive ones included, into the registry', async () => {
    await renderLoader();
    expect(mockGetCurrencies).toHaveBeenCalledTimes(1);
    expect(mockGetCurrencies).toHaveBeenCalledWith(true);
    expect(decimalPlacesForCurrency('BTC')).toBe(4);
  });

  it('registers each currency\'s stored symbol with its places', async () => {
    mockGetCurrencies.mockResolvedValue([{ ...BTC, symbol: '\u20bf' }]);
    await renderLoader();
    expect(symbolForCurrency('BTC')).toBe('\u20bf');
  });

  it('loads once per session, not on every render', async () => {
    const { rerender } = await renderLoader();
    await act(async () => {
      rerender(<CurrencyRegistryLoader />);
    });
    expect(mockGetCurrencies).toHaveBeenCalledTimes(1);
  });

  it('waits for the auth store to hydrate', async () => {
    authState = { isAuthenticated: true, _hasHydrated: false };
    await renderLoader();
    expect(mockGetCurrencies).not.toHaveBeenCalled();
  });

  it('loads nothing while signed out, and empties the registry', async () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 4 }]);
    authState = { isAuthenticated: false, _hasHydrated: true };
    await renderLoader();
    expect(mockGetCurrencies).not.toHaveBeenCalled();
    expect(decimalPlacesForCurrency('BTC')).toBeUndefined();
  });

  it('logs a failed load, leaves the registry empty and renders nothing', async () => {
    mockGetCurrencies.mockRejectedValue(new Error('offline'));
    const { container } = await renderLoader();
    await act(async () => {});
    expect(mockLoggerError).toHaveBeenCalled();
    expect(decimalPlacesForCurrency('BTC')).toBeUndefined();
    expect(container).toBeEmptyDOMElement();
  });

  it('empties on sign-out and loads again on the next sign-in', async () => {
    const { rerender } = await renderLoader();
    expect(decimalPlacesForCurrency('BTC')).toBe(4);

    authState = { isAuthenticated: false, _hasHydrated: true };
    await act(async () => {
      rerender(<CurrencyRegistryLoader />);
    });
    expect(decimalPlacesForCurrency('BTC')).toBeUndefined();

    authState = { isAuthenticated: true, _hasHydrated: true };
    await act(async () => {
      rerender(<CurrencyRegistryLoader />);
    });
    expect(mockGetCurrencies).toHaveBeenCalledTimes(2);
    expect(decimalPlacesForCurrency('BTC')).toBe(4);
  });

  it('drops an answer that arrives after the session it was for ended', async () => {
    let resolve: (value: unknown) => void = () => {};
    mockGetCurrencies.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const { rerender } = await renderLoader();

    authState = { isAuthenticated: false, _hasHydrated: true };
    await act(async () => {
      rerender(<CurrencyRegistryLoader />);
    });
    await act(async () => {
      resolve([BTC]);
    });
    expect(decimalPlacesForCurrency('BTC')).toBeUndefined();
  });
});
