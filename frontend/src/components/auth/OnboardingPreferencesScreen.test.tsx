import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@/test/render';
import { OnboardingPreferencesScreen } from './OnboardingPreferencesScreen';

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getCurrencyCatalog: vi.fn().mockResolvedValue([
      { code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2 },
    ]),
  },
}));

vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    updatePreferences: vi.fn().mockResolvedValue({ language: 'en', defaultCurrency: 'USD' }),
  },
}));

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector: (s: unknown) => unknown) =>
    selector({ updatePreferences: vi.fn() }),
}));

vi.mock('js-cookie', () => ({ default: { set: vi.fn(), get: vi.fn() } }));

async function renderScreen(onComplete = vi.fn()) {
  await act(async () => {
    render(<OnboardingPreferencesScreen onComplete={onComplete} />);
  });
  return { onComplete };
}

describe('OnboardingPreferencesScreen', () => {
  beforeEach(() => vi.clearAllMocks());

  it('frames the preferences step with its heading and both selectors', async () => {
    await renderScreen();
    expect(screen.getByText('Set Your Preferences')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Choose your language and the currency Monize should use by default. You can change these later in Settings.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Language')).toBeInTheDocument();
    expect(screen.getByLabelText('Default currency')).toBeInTheDocument();
  });

  it('seeds the language selector from the active locale', async () => {
    await renderScreen();
    expect(screen.getByLabelText('Language')).toHaveValue('en');
  });

  it('reports completion to the caller', async () => {
    const { onComplete } = await renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByText('Continue'));
    });
    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith({ localeChanged: false }),
    );
  });
});
